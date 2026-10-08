"""Central Recordings-folder pipeline - the piece Venki described directly
in the 29 Sep Orient-Me meeting: recordings all land in ONE shared OneDrive
folder, not one per project, so unlike core/watcher.py's per-topic
SourceFolder poll, this has to figure out on its own which project a given
recording belongs to - matching an existing Topic, or flagging that it
looks like a brand new one for a PERSON to confirm (never created silently
- Ayush's explicit correction, 29 Sep: "dont automatically add... give user
an option to do so or reject the project creation").

Every file gets exactly one RecordingEvent row regardless of outcome -
routed, pending a new-project decision, needs manual review, or errored -
so the Transcripts page always has an honest, complete picture, never a
silent background action nobody can see or undo.
"""

import hashlib
import json
import logging
import os
import re
from datetime import datetime

from django.utils import timezone

from . import extraction, ingestion, local_llm
from .models import IngestedFile, RecordingEvent, Settings, SourceFolder, Topic

logger = logging.getLogger(__name__)

_UNSAFE_FOLDER_CHARS = re.compile(r'[\\/:*?"<>|]')


def _safe_folder_name(name):
    cleaned = _UNSAFE_FOLDER_CHARS.sub("", name).strip()
    return cleaned or "Untitled Project"


INBOX_TOPIC_NAME = "Inbox"


def get_or_create_inbox_topic():
    """The one singleton landing spot for a dropped file/folder that didn't
    confidently match an existing project - Ayush's own product call, 30
    Sep: a random folder of docs shouldn't be forced to become (or block
    on) a "Project", but it also shouldn't sit in an unusable, unsearchable
    limbo waiting for someone to tag it one file at a time. It's a REAL
    Topic (topic_type='general') so everything that already works for any
    other topic - Ask/Chat, brief generation, and GlobalSearchView - works
    on Inbox content for free, no special-casing anywhere else. get_or_
    create keyed on (name, topic_type) so this is idempotent even if called
    concurrently by two uploads landing at the same moment."""
    topic, _ = Topic.objects.get_or_create(
        name=INBOX_TOPIC_NAME,
        topic_type="general",
        defaults={"one_liner": "Files dropped without a confident project match - move them out any time."},
    )
    return topic


def _resolve_recording_date(file_path):
    """The real meeting/recording date - the same Teams filename regex
    ingestion._guess_recording_title_and_date already uses to build the
    transcript's own "Date:"/"Time:" header lines, just also stored as a
    real field on the RecordingEvent itself. This is the actual fix for a
    real, reported bug: until this field existed, every recording (whether
    freshly routed or bulk-classified as 'pre_existing' when the watcher
    first turned on) only ever showed detected_at - when THIS APP happened
    to notice the file, not when the meeting happened. For anything synced
    from OneDrive with any lag, or any pre_existing backfill, those two
    dates can be days or months apart.

    Filename regex first (no disk I/O, works even before the self-claiming
    get_or_create has confirmed the file still exists), then the file's own
    mtime, then None - callers fall back to detected_at in that last case,
    same as before this field existed."""
    m = ingestion._TEAMS_FILENAME_RE.match(os.path.splitext(os.path.basename(file_path))[0])
    if m:
        try:
            return timezone.make_aware(datetime.strptime(m.group("date") + m.group("time"), "%Y%m%d%H%M%S"))
        except ValueError:
            pass
    if os.path.exists(file_path):
        return timezone.make_aware(datetime.fromtimestamp(os.path.getmtime(file_path)))
    return None


def _write_transcript_file(topic, original_path, text):
    """Writes the transcribed text as a real .txt file into the project's
    OWN folder - so opening that project's real folder (OneDrive, a local
    folder) shows the transcript sitting right there, not just inside
    OrientMe's own database (Ayush's explicit ask, 29 Sep: "automatically
    put the respective transcript details to the project folder").

    Uses the topic's first linked SourceFolder when one exists. A brand-new
    auto-created topic has none yet, so one is created for it - a fresh
    folder under a clearly-labeled 'OrientMe Auto-Created Projects' root
    next to the watched Recordings folder, registered as its first
    SourceFolder - so it behaves like any other project folder from then on
    (visible in Explorer, scanned by the per-topic watcher too).

    The returned path becomes the IngestedFile's own `path` (not the
    original recording's path in the Recordings folder) - this is what lets
    the per-topic watcher's own later re-scan of this same folder recognize
    the file by its unchanged content_hash instead of re-ingesting it as a
    second, duplicate copy."""
    folder = topic.folders.first()
    if folder is None:
        recordings_root = Settings.get("recordings_watch_folder", "").strip()
        base = os.path.dirname(recordings_root.rstrip("\\/")) if recordings_root else os.path.dirname(original_path)
        target_dir = os.path.join(base, "OrientMe Auto-Created Projects", _safe_folder_name(topic.name))
        os.makedirs(target_dir, exist_ok=True)
        SourceFolder.objects.create(topic=topic, path=target_dir)
    else:
        target_dir = folder.path
        os.makedirs(target_dir, exist_ok=True)

    stem = os.path.splitext(os.path.basename(original_path))[0]
    dest_path = os.path.join(target_dir, f"{stem} - Transcript.txt")
    with open(dest_path, "w", encoding="utf-8") as f:
        f.write(text)
    return dest_path


def _confident_name_match(text, topics):
    """A precision-first, LOCAL check - deliberately NOT extraction.
    resolve_topic's own scoring, which is tuned for short typed questions
    (where any word overlap is a reasonable signal to act on). Reusing it
    against a full transcript was tried first and failed a real test on
    29 Sep: an unrelated transcript about a "Vendor Onboarding" project was
    scored as a confident "matched" against the existing "Linkedin
    Marketing" topic, purely because a couple of generic words in that
    topic's own already-ingested task titles happened to appear somewhere
    in the transcript - resolve_topic has no minimum-confidence floor (any
    non-zero unique max counts), which is fine when a person just typed a
    real question, but not nearly strict enough for an automated pipeline
    silently deciding where to file a recording.

    Requires the topic's own name to appear as a whole word/phrase in the
    transcript - a much higher, precision-first bar. Anything that doesn't
    clear it still gets a real shot via the LLM router below, which reasons
    about the actual content instead of counting word overlaps."""
    lowered = text.lower()
    hits = [
        topic
        for topic in topics
        if topic.name.strip() and re.search(r"\b" + re.escape(topic.name.strip().lower()) + r"\b", lowered)
    ]
    return hits[0] if len(hits) == 1 else None


def _walk_recordings(folder_path, max_depth=2):
    """Same top-level-plus-one-subfolder-deep convention as
    ingestion._walk_files, widened by one extra level since a shared
    Recordings folder is more likely to have a person/date subfolder
    structure than a single project's own lookup folder."""
    base_depth = folder_path.rstrip(os.sep).count(os.sep)
    for root, dirs, files in os.walk(folder_path):
        depth = root.rstrip(os.sep).count(os.sep) - base_depth
        if depth >= max_depth:
            dirs[:] = []
        for name in files:
            if os.path.splitext(name)[1].lower() in ingestion.AUDIO_VIDEO_EXTENSIONS:
                yield os.path.join(root, name)


def _walk_manual_drop_files(folder_path, max_depth=2):
    """Same shape as _walk_recordings, but for Venki's own manual drop
    folder (30 Sep meeting: "there will be a common folder... he will put
    random data... shortcut to mark to projects") - deliberately no
    extension filter, since this folder is explicitly for "random data",
    not just audio/video. process_new_recording (called with
    allow_llm_routing=False for this source) already tolerates any file
    ingestion.extract_text can't handle by landing it as status='error'
    with a clear message, so nothing here needs its own extension check."""
    base_depth = folder_path.rstrip(os.sep).count(os.sep)
    for root, dirs, files in os.walk(folder_path):
        depth = root.rstrip(os.sep).count(os.sep) - base_depth
        if depth >= max_depth:
            dirs[:] = []
        for name in files:
            yield os.path.join(root, name)


def _current_settings_dict():
    # Local import - views.py imports this module too (assign_topic), so a
    # top-level import here would be circular.
    from .views import _current_llm_settings

    return _current_llm_settings()


ROUTE_RECORDING_PROMPT = """A new meeting recording was just transcribed. Decide whether it belongs to \
one of these existing projects OrientMe already tracks, or describes a new one:

{topic_list}

Only choose "new" if the transcript is clearly about a distinct, ongoing initiative/project genuinely \
not covered by anything in the list above - never invent a new project for a recording that's just a \
routine update on an existing one, and never for something that isn't really a project at all (a \
hiring interview, a one-off external call, a personal conversation) - choose "unsure" for those instead \
of forcing a fit.

Transcript (may be partial):
{text}"""

ROUTE_RECORDING_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["existing", "new", "unsure"]},
        "topic_id": {"type": "integer"},
        "new_name": {"type": "string"},
        "new_one_liner": {"type": "string"},
        "new_topic_type": {
            "type": "string",
            "enum": ["project", "area", "process", "person", "customer", "opportunity"],
        },
    },
    "required": ["action"],
}


def _suggest_topic_via_llm(text, existing_topics, settings):
    """Asks a LOCAL model (Ollama, core/local_llm.py) to decide: does this
    transcript belong to one of the existing topics, or does it describe a
    new project/initiative that should get its own? Deliberately local, not
    the OpenRouter path this used before - Venki's own stated concern in
    the 30 Sep recording: "let that be a local kind of thing... it's not
    [like] all transcript should go out". Schema-constrained (see
    local_llm.call_local_llm) so even the small 3b model returns a reliably
    parseable answer. `settings` is accepted (unused) only so the one
    remaining caller (process_new_recording) doesn't need updating.

    Returns {"action": "unsure"} if Ollama isn't reachable - never invents
    a match/new-project without a real answer, same graceful-fallback
    convention as every other LLM call in this app."""
    topic_list = (
        "\n".join(
            f"- id={t.id}: {t.name} ({t.get_topic_type_display()}) - {t.one_liner}"
            for t in existing_topics
        )
        or "(no existing projects yet)"
    )
    prompt = ROUTE_RECORDING_PROMPT.format(topic_list=topic_list, text=text[:6000])
    raw = local_llm.call_local_llm(prompt, schema=ROUTE_RECORDING_SCHEMA)
    if not raw:
        return {"action": "unsure"}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Auto-route: local LLM reply wasn't parseable JSON: %r", raw[:300])
        return {"action": "unsure"}


def _ingest_into_topic(topic, original_path, text, refresh_brief=True):
    """Writes the transcript into the project's own real folder
    (_write_transcript_file), then stores THAT path as a real IngestedFile
    on the target topic and runs it through the same extraction/brief-
    refresh steps a manual upload gets - reuses core.views.
    _extract_and_store/_ask_topic rather than duplicating that logic
    (local import: views.py imports this module too, for assign_topic).

    refresh_brief=False skips the brief regeneration (a real LLM call) for
    this one file - added after a real bug (Ayush, 30 Sep): dropping a
    whole folder of files that all auto-matched the same project fired one
    full LLM brief regeneration PER FILE, back to back, synchronously in
    one request - easily outrunning the browser's own timeout on anything
    more than a handful of files ("Failed to fetch" with no server error at
    all). Bulk callers (the upload endpoint) now request exactly one
    refresh per distinct topic after the whole batch finishes, not one per
    file - see RecordingEventViewSet.upload."""
    from .views import CONTEXT_BRIEF_QUESTION, _ask_topic, _extract_and_store

    dest_path = _write_transcript_file(topic, original_path, text)
    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    obj, _ = IngestedFile.objects.update_or_create(
        topic=topic,
        path=dest_path,
        defaults={
            "display_name": os.path.basename(dest_path),
            "source_method": "folder",
            "extracted_text": text,
            "content_hash": content_hash,
            "extraction_error": "",
        },
    )
    _extract_and_store(obj)
    if refresh_brief:
        _ask_topic(topic, CONTEXT_BRIEF_QUESTION)
    return obj


def process_new_recording(file_path, source="watched_folder", allow_llm_routing=True, refresh_brief=True):
    """One recording file, all the way through: transcribe -> route to an
    existing topic / flag a possible new one for a person to confirm /
    flag for manual review -> ingest -> log a RecordingEvent. Never raises -
    any failure is caught and logged as a RecordingEvent with
    status='error', so one bad file never stops the watcher tick that
    calls this.

    Self-claiming: the very first thing this does is get_or_create its own
    RecordingEvent row, and bails out immediately if one already existed.
    This is what makes it safe to call from more than one place (the
    watcher's own tick, and a manual reprocess) without risk of two calls
    racing on the same file and creating two different projects for it - a
    real bug hit during testing on 29 Sep before this guard existed.

    `source`/`allow_llm_routing` are what let tick_manual_drop_folder reuse
    this exact function for Venki's manual-drop folder instead of
    duplicating this whole pipeline: same self-claim, same extraction, same
    code-only _confident_name_match, just skipping the LLM-routing step
    entirely (allow_llm_routing=False) so a person always makes that call
    themselves via the quick-tag picker - never automatic for that source."""
    _placeholder, claimed = RecordingEvent.objects.get_or_create(
        file_path=file_path,
        defaults={
            "status": "needs_review", "detail": "Processing…", "source": source,
            "recording_date": _resolve_recording_date(file_path),
        },
    )
    if not claimed:
        return

    if not os.path.exists(file_path):
        # Listed by this tick but gone by the time we get here (renamed,
        # moved, or deleted a moment later) - a real, legitimate race, not
        # a processing failure. Leaves an honest, clearly-labeled row
        # rather than silently vanishing or hanging as "Processing…" forever.
        RecordingEvent.objects.filter(file_path=file_path).update(
            status="error", detail="File disappeared before it could be processed."
        )
        return

    # A file type nothing here can even attempt to read - never worth a
    # permanent row (see RecordingEventViewSet.upload's own, primary check;
    # this is defense-in-depth for the other caller of this function, the
    # disk-watched manual-drop-folder poller, which has no per-file loop of
    # its own to check extensions before calling in). Deletes its own
    # just-claimed placeholder rather than leaving it as an orphaned
    # "Processing…" row forever.
    if os.path.splitext(file_path)[1].lower() not in ingestion.SUPPORTED_EXTENSIONS:
        _placeholder.delete()
        return

    try:
        text = ingestion.extract_text(file_path)
    except Exception as exc:  # noqa: BLE001 - log it on the event, don't crash the tick
        RecordingEvent.objects.update_or_create(
            file_path=file_path, defaults={"status": "error", "detail": str(exc)[:500]}
        )
        return

    if not text.strip():
        RecordingEvent.objects.update_or_create(
            file_path=file_path,
            defaults={"status": "error", "detail": "Transcription produced no text."},
        )
        return

    settings = _current_settings_dict()
    engine_used = Settings.get("transcription_engine", "local_whisper")
    suggest_new = Settings.get("recordings_suggest_new_topics", "true") == "true"

    existing_topics = list(Topic.objects.all())

    matched_topic = _confident_name_match(text, existing_topics)
    if matched_topic:
        obj = _ingest_into_topic(matched_topic, file_path, text, refresh_brief=refresh_brief)
        RecordingEvent.objects.update_or_create(
            file_path=file_path,
            defaults={
                "topic": matched_topic, "ingested_file": obj, "status": "routed", "engine_used": engine_used,
                "detail": f"Matched - '{matched_topic.name}' is named directly in the transcript.",
            },
        )
        return

    if not allow_llm_routing:
        # No confident project-name match, and this source (manual drop -
        # a person dropping a folder/files straight into the browser) never
        # gets LLM-assisted routing. Used to leave this sitting as
        # 'needs_review' with no IngestedFile at all - unsearchable, un-
        # askable, real content stuck in limbo until someone tagged it one
        # file at a time. Real complaint hit dropping a whole project
        # folder (Ayush, 30 Sep): dozens of files piled up requiring manual
        # per-file attention, AND showed up on the Transcripts page (a
        # different, meeting-focused concept) with no way to remove them.
        # Filing straight into the Inbox topic instead means the content is
        # immediately real - searchable, chattable, brief-able - the same
        # moment it lands, and moving it into a real project later is an
        # explicit choice a person makes when they're ready, not a
        # precondition for the file being usable at all.
        inbox = get_or_create_inbox_topic()
        obj = _ingest_into_topic(inbox, file_path, text, refresh_brief=refresh_brief)
        RecordingEvent.objects.update_or_create(
            file_path=file_path,
            defaults={
                "topic": inbox, "ingested_file": obj, "status": "inbox", "engine_used": engine_used,
                "detail": "No confident project match - filed to Inbox. Move it to a project any time.",
            },
        )
        return

    if not suggest_new:
        RecordingEvent.objects.update_or_create(
            file_path=file_path,
            defaults={
                "status": "needs_review", "engine_used": engine_used,
                "detail": "No confident topic match, and new-project suggestions are turned off in Settings.",
            },
        )
        return

    decision = _suggest_topic_via_llm(text, existing_topics, settings)

    if decision.get("action") == "existing" and decision.get("topic_id"):
        topic = Topic.objects.filter(id=decision["topic_id"]).first()
        if topic:
            obj = _ingest_into_topic(topic, file_path, text, refresh_brief=refresh_brief)
            RecordingEvent.objects.update_or_create(
                file_path=file_path,
                defaults={
                    "topic": topic, "ingested_file": obj, "status": "routed", "engine_used": engine_used,
                    "detail": "Matched by LLM to an existing project.",
                },
            )
            return

    if decision.get("action") == "new" and decision.get("new_name"):
        # Never create the Topic here - only ever from an explicit human
        # decision (RecordingEventViewSet.confirm_new_project). This just
        # records the suggestion and waits.
        RecordingEvent.objects.update_or_create(
            file_path=file_path,
            defaults={
                "status": "pending_new_project", "engine_used": engine_used,
                "detail": "Looks like a new project - review the suggested name and confirm or reject.",
                "suggested_topic_name": decision["new_name"][:200],
                "suggested_topic_one_liner": (decision.get("new_one_liner") or "")[:300],
                "suggested_topic_type": decision.get("new_topic_type") or "project",
                "pending_extracted_text": text,
            },
        )
        return

    RecordingEvent.objects.update_or_create(
        file_path=file_path,
        defaults={
            "status": "needs_review", "engine_used": engine_used,
            "detail": "No confident match, and not clearly a new project - needs manual assignment.",
        },
    )


def confirm_new_project(event, name=None, one_liner=None, topic_type=None):
    """Creates the Topic a person just approved from a 'pending_new_project'
    RecordingEvent - the only place a brand new Topic is ever created by
    this pipeline, and only ever from this explicit human decision (see
    RecordingEvent's own docstring). Overrides let the person adjust the
    LLM's suggested name/type before it becomes real, rather than being
    stuck with whatever it guessed."""
    topic = Topic.objects.create(
        name=(name or event.suggested_topic_name or "Untitled Project")[:200],
        topic_type=topic_type or event.suggested_topic_type or "project",
        one_liner=(one_liner if one_liner is not None else event.suggested_topic_one_liner)[:300],
        auto_created=True,
    )
    text = event.pending_extracted_text or ingestion.extract_text(event.file_path)
    obj = _ingest_into_topic(topic, event.file_path, text)
    event.topic = topic
    event.ingested_file = obj
    event.status = "auto_created"
    event.detail = "New project created from this recording."
    event.pending_extracted_text = ""
    event.save()
    return event


def reject_new_project(event):
    """The other half of the decision - the person confirms this ISN'T a
    new project. Falls back to plain manual review rather than a dead end,
    since the recording may still belong to an existing project a person
    can pick by hand."""
    event.status = "needs_review"
    event.detail = "Declined as a new project - assign manually if needed, or leave as a one-off."
    event.pending_extracted_text = ""
    event.save()
    return event


def _current_transcript_text(event):
    """Whatever text currently represents this recording - the real
    IngestedFile's own extracted_text once routed/confirmed into a project,
    or the pending_extracted_text held on the event itself before that (see
    RecordingEvent's own docstring on why the two are mutually exclusive)."""
    return event.ingested_file.extracted_text if event.ingested_file else event.pending_extracted_text


def generate_summary_for_event(event, settings=None):
    """The Transcripts detail page's on-demand 'Generate Summary' button -
    never called automatically alongside transcription itself, only from a
    person's own click (RecordingEventViewSet.generate_summary).

    Deliberately code-based, not an LLM call (Ayush's explicit correction,
    29 Sep: "you are using too much llm... focus on codded thing rather
    than using llm - llm is for tuff works which is imposible to code").
    extraction.build_meeting_summary already does everything a summary here
    needs from purely local, deterministic signals - see its own docstring.
    `settings` is accepted (unused) only so callers/tests that still pass it
    don't need updating.

    Persists the result on the event row so re-opening the page later shows
    the same thing without re-generating - "Save" (save_summary_to_project,
    below) only additionally writes it out to the project's real folder."""
    text = _current_transcript_text(event)
    action_items = []
    if event.ingested_file:
        action_items = list(
            event.ingested_file.tasks.values("title", "assignee", "due_date").order_by("due_date", "created_at")
        )
    summary_text = extraction.build_meeting_summary(text, action_items=action_items)
    event.meeting_summary = summary_text
    event.summary_generated_at = timezone.now()
    event.save()
    return event, False, None


DIARIZE_PROMPT = """Below is a transcript of a real meeting between real people at a company - it is NOT \
a conversation with you, and you are not one of the people in it. Extract a structured breakdown using \
ONLY what is word-for-word supported by the text below - never invent names, decisions, action items, \
or speakers that aren't clearly there, and never assume you (an AI assistant) are one of the \
participants. Leave an array empty (not made-up content) if a section genuinely doesn't apply, and use \
"Speaker 1"/"Speaker 2" etc for anyone whose real name isn't actually stated.

Transcript:
{text}"""

DIARIZE_SCHEMA = {
    "type": "object",
    "properties": {
        "participants": {
            "type": "string",
            "description": "Real people's names actually mentioned in the transcript, comma-separated, or 'Not identifiable from transcript text' - never 'User'/'Assistant'.",
        },
        "overall_summary": {"type": "string", "description": "2-4 plain-language sentences"},
        "decisions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "what": {"type": "string"},
                    "rationale": {"type": "string"},
                    "decider": {"type": "string"},
                },
                "required": ["what"],
            },
        },
        "action_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "owner": {"type": "string", "description": "Real name if said, otherwise 'Unassigned'"},
                    "task": {"type": "string"},
                    "deadline": {"type": "string"},
                },
                "required": ["task"],
            },
        },
        "parked_items": {"type": "array", "items": {"type": "string"}},
        "per_speaker": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "speaker": {"type": "string", "description": "A real person's name if one is actually said in the transcript; otherwise 'Speaker 1', 'Speaker 2' etc - never 'User' or 'Assistant', this is a meeting between people, not a chat."},
                    "summary": {"type": "string"},
                },
                "required": ["speaker", "summary"],
            },
        },
    },
    "required": ["participants", "overall_summary", "decisions", "action_items", "parked_items", "per_speaker"],
}


def _render_diarization_markdown(title, data):
    """Turns the model's structured JSON into the same markdown shape as
    the reference example in 'Diarizer Example/' - kept as plain Python
    string-building, not another LLM call, so the actual formatting is
    100% deterministic regardless of what the model returns."""
    lines = [f"# Meeting Summary: {title}", ""]
    lines.append(f"**Meeting Participants:** {data.get('participants') or 'Not identifiable from transcript text'}")
    lines.append("")
    lines.append("## Overall Meeting Summary")
    lines.append(data.get("overall_summary") or "None found")
    lines.append("")
    lines.append("## Decision Records")
    decisions = data.get("decisions") or []
    if decisions:
        for i, d in enumerate(decisions, start=1):
            what = (d.get("what") or "").strip()
            if not what:
                continue
            extra = []
            if d.get("rationale"):
                extra.append(f"Rationale: {d['rationale']}")
            if d.get("decider"):
                extra.append(f"Decider: {d['decider']}")
            suffix = f" ({'; '.join(extra)})" if extra else ""
            lines.append(f"{i}. {what}{suffix}")
    else:
        lines.append("None found")
    lines.append("")
    lines.append("## Action Items")
    actions = data.get("action_items") or []
    if actions:
        for i, a in enumerate(actions, start=1):
            task = (a.get("task") or "").strip()
            if not task:
                continue
            owner = a.get("owner") or "Unassigned"
            suffix = f" (Deadline: {a['deadline']})" if a.get("deadline") else ""
            lines.append(f"{i}. Owner: {owner} — {task}{suffix}")
    else:
        lines.append("None found")
    lines.append("")
    lines.append("## Parked Items")
    parked = [p for p in (data.get("parked_items") or []) if (p or "").strip()]
    if parked:
        for p in parked:
            lines.append(f"- {p}")
    else:
        lines.append("None found")
    lines.append("")
    lines.append("## Per-Speaker Summary")
    per_speaker = data.get("per_speaker") or []
    if per_speaker:
        for s in per_speaker:
            if not (s.get("speaker") or "").strip():
                continue
            lines.append(f"### {s['speaker']}")
            lines.append(s.get("summary") or "")
            lines.append("")
    else:
        lines.append("None found")
    return "\n".join(lines).strip()


def diarize_event(event):
    """The detail page's 'Diarize' button - asks a LOCAL model (Ollama,
    core/local_llm.py) to turn the raw transcript into the same structured
    shape as the reference example in 'Diarizer Example/' (participants,
    decisions, action items, parked items, per-speaker summary) - Ayush's
    30 Sep ask: "the output should come like that for diarize".

    Deliberately local for the same reason _suggest_topic_via_llm is:
    Venki's own stated concern that meeting transcripts shouldn't leave
    this machine. Real audio-based speaker diarization (distinguishing
    voices from the audio itself) was investigated earlier and declined -
    resemblyzer needs torch plus an unbuildable webrtcvad dependency on
    this machine - so speaker attribution here comes from the model
    reading the text itself (who refers to themselves, who's addressed by
    name), same as the reference example's own "[Unidentified speaker]"
    labels show it was built the same way, not from a real audio pipeline.

    Schema-constrained (DIARIZE_SCHEMA), not a free-text markdown ask - a
    real test on 30 Sep showed the small local model doesn't reliably
    follow a free-form template, but reliably fills a constrained JSON
    schema. _render_diarization_markdown then builds the actual markdown
    deterministically from that JSON, so formatting never depends on the
    model getting punctuation/headings right.

    Returns (event, succeeded, message) - never raises. `succeeded=False`
    with a clear message when Ollama isn't reachable, same honest-by-
    construction convention as every other step in this pipeline."""
    text = _current_transcript_text(event)
    if not (text or "").strip():
        return event, False, "No transcript text is available yet for this recording."

    title = os.path.splitext(os.path.basename(event.file_path))[0]
    prompt = DIARIZE_PROMPT.format(text=text[:12000])
    raw = local_llm.call_local_llm(prompt, timeout=240, schema=DIARIZE_SCHEMA)
    if not raw:
        return event, False, (
            f"Local model ({local_llm.OLLAMA_MODEL}) isn't reachable - make sure `ollama serve` is "
            "running and the model is pulled, then try again."
        )
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Diarize: local LLM reply wasn't parseable JSON: %r", raw[:300])
        return event, False, "The local model returned something unreadable - try again."

    event.diarization_result = _render_diarization_markdown(title, data)
    event.diarization_generated_at = timezone.now()
    event.save()
    return event, True, "Diarization complete."


_LINE_TIMESTAMP_RE = re.compile(r"^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$")


def _parse_timestamped_lines(text):
    """Every [MM:SS]/[H:MM:SS] line in the raw transcript, as real
    (timestamp, text) pairs straight from the source - the header lines
    (Title/Date/Time/Attendees) don't match this pattern and are skipped,
    same as they're already excluded from every other downstream use of
    this text."""
    out = []
    for line in text.splitlines():
        m = _LINE_TIMESTAMP_RE.match(line.strip())
        if m and m.group(2).strip():
            out.append((m.group(1), m.group(2).strip()))
    return out


SPEAKER_GROUPING_PROMPT = """Below is a numbered list of lines from a real meeting transcript, one \
speech fragment per line. Your ONLY job is to say which lines were spoken by the same person - group \
consecutive line numbers that are clearly the same speaker. Do NOT rewrite, summarize, or quote the \
text back; only the line numbers and a speaker label per group. Use a real name only if someone is \
actually addressed by name or introduces themselves in the text; otherwise use "Speaker 1", "Speaker \
2", etc, consistently - the same unnamed speaker must keep the same label every time they speak. This \
is a meeting between real people, never label anyone "User" or "Assistant".

{numbered_lines}"""

SPEAKER_GROUPING_SCHEMA = {
    "type": "object",
    "properties": {
        "groups": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_line": {"type": "integer"},
                    "end_line": {"type": "integer"},
                    "speaker": {"type": "string"},
                },
                "required": ["start_line", "end_line", "speaker"],
            },
        },
    },
    "required": ["groups"],
}


def generate_speaker_transcript(event):
    """The detail page's 'Generate Transcript' button - Speaker Name +
    Timestamp + Speech per turn (Ayush, 30 Sep).

    Deliberately NOT "ask the model to rewrite the transcript" - a real
    test on 30 Sep showed that approach fabricates entire lines of
    dialogue that were never said, on a long/messy real transcript (it
    invented a "System:" line that doesn't exist anywhere in the source).
    Every real timestamp and every real word here comes straight from
    _parse_timestamped_lines, in code, never touched by the model. The
    model's ONLY job is grouping already-real line numbers by speaker
    (SPEAKER_GROUPING_SCHEMA) - a much lower-stakes task, since the worst
    a wrong answer can do is mislabel who said something, never invent
    what was said. Any line number the model doesn't cover falls back to
    the same label as the line before it (or "Speaker 1" for the first),
    so a partial/short answer degrades gracefully instead of losing lines."""
    text = _current_transcript_text(event)
    if not (text or "").strip():
        return event, False, "No transcript text is available yet for this recording."

    lines = _parse_timestamped_lines(text)
    if not lines:
        return event, False, "No timestamped transcript lines were found to split into speaker turns."

    numbered = "\n".join(f"{i}. {t}" for i, (_ts, t) in enumerate(lines, start=1))
    prompt = SPEAKER_GROUPING_PROMPT.format(numbered_lines=numbered[:12000])
    raw = local_llm.call_local_llm(prompt, timeout=240, schema=SPEAKER_GROUPING_SCHEMA)

    speaker_by_line = {}
    if raw:
        try:
            for g in json.loads(raw).get("groups") or []:
                start, end = g.get("start_line"), g.get("end_line")
                speaker = (g.get("speaker") or "").strip()
                if isinstance(start, int) and isinstance(end, int) and speaker:
                    for i in range(start, min(end, len(lines)) + 1):
                        speaker_by_line[i] = speaker
        except json.JSONDecodeError:
            logger.warning("Generate Transcript: local LLM reply wasn't parseable JSON: %r", raw[:300])

    rendered_lines = []
    last_speaker = "Speaker 1"
    for i, (ts, body) in enumerate(lines, start=1):
        speaker = speaker_by_line.get(i, last_speaker)
        last_speaker = speaker
        rendered_lines.append(f"[{ts}] {speaker}: {body}")

    event.speaker_transcript = "\n".join(rendered_lines)
    event.speaker_transcript_generated_at = timezone.now()
    event.save()
    if not raw:
        return event, True, (
            f"Local model ({local_llm.OLLAMA_MODEL}) wasn't reachable, so every line is grouped under "
            "one placeholder speaker - the timestamps and text are still real, just not split by "
            "speaker. Try again once Ollama is running for real speaker grouping."
        )
    return event, True, "Transcript generated."


def save_summary_to_project(event):
    """'Save' on the Transcripts detail page - meaningful only once this
    recording is assigned to a project (generating a summary already
    persists it to the database regardless; this specifically writes it out
    to that project's real folder on disk too, same 'shows up in the real
    folder' convention _write_transcript_file already established for the
    transcript itself). Returns (dest_path, None) on success, (None, error)
    otherwise - never raises."""
    if not event.topic:
        return None, "This recording isn't assigned to a project yet - assign it first."
    if not (event.meeting_summary or "").strip():
        return None, "No summary has been generated yet - generate one first."
    folder = event.topic.folders.first()
    if folder is None:
        return None, "This project has no folder to save into yet."
    target_dir = folder.path
    os.makedirs(target_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(event.file_path))[0]
    dest_path = os.path.join(target_dir, f"{stem} - Summary.txt")
    with open(dest_path, "w", encoding="utf-8") as f:
        f.write(event.meeting_summary)
    return dest_path, None


def tick_central_recordings_folder():
    """Called once per core/watcher.py tick. Only ever acts on a file it
    hasn't already logged a RecordingEvent for - the same change-detection
    role content_hash plays in ingestion.ingest_folder, just keyed on path
    here since these files (often 100s of MB) are never worth re-reading
    just to hash them."""
    folder = Settings.get("recordings_watch_folder", "").strip()
    if not folder or not os.path.isdir(folder):
        return
    seen_paths = set(RecordingEvent.objects.values_list("file_path", flat=True))
    for path in _walk_recordings(folder):
        if path in seen_paths:
            continue
        process_new_recording(path)


def tick_manual_drop_folder():
    """Called once per core/watcher.py tick, alongside
    tick_central_recordings_folder. This is Venki's own ask from the 30 Sep
    recording: a second, common folder location where he (or anyone) can
    put "random data" - any file type, dropped one at a time or in a batch
    - and get a fast, manual "shortcut to mark to projects" instead of the
    Recordings folder's fully-automatic routing. Reuses process_new_recording
    with allow_llm_routing=False so nothing here ever calls out to an LLM;
    the only auto-suggestion offered is the same free, code-only
    _confident_name_match() the watched-folder path also tries first."""
    folder = Settings.get("manual_drop_folder", "").strip()
    if not folder or not os.path.isdir(folder):
        return
    seen_paths = set(RecordingEvent.objects.values_list("file_path", flat=True))
    for path in _walk_manual_drop_files(folder):
        if path in seen_paths:
            continue
        process_new_recording(path, source="manual_drop", allow_llm_routing=False)
