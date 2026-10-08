import csv
import hashlib
import hmac
import io
import logging
import os
import re
import subprocess
import sys
import threading
import uuid
from datetime import datetime

from django.conf import settings as django_settings
from django.contrib.auth import authenticate
from django.contrib.auth import login as django_login
from django.contrib.auth import logout as django_logout
from django.contrib.auth import update_session_auth_hash
from django.db import connection
from django.db.models import F, Q
from django.http import HttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404
from django.utils import timezone
from html import escape as html_escape
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from . import corrections, doc_meta, evidence, extraction, ics_import, ingestion, llm_brief, mbox_import, recordings
from .models import (
    CaseSummary,
    ChatMessage,
    Commitment,
    ConnectorStatus,
    Contact,
    DOC_TYPES,
    Decision,
    ExtractedMeta,
    GlobalChatMessage,
    IngestedFile,
    Loop,
    MEETING_TYPES,
    MeetingNote,
    ProjectState,
    RecordingEvent,
    Risk,
    ScanJob,
    SearchLog,
    Settings,
    SourceFolder,
    TASK_STATUSES,
    Task,
    Topic,
    Workflow,
)
from .serializers import (
    CaseSummarySerializer,
    ChatMessageSerializer,
    CommitmentSerializer,
    ContactSerializer,
    DecisionSerializer,
    GlobalChatMessageSerializer,
    LoopSerializer,
    MeetingNoteSerializer,
    ProjectStateSerializer,
    RecordingEventSerializer,
    RiskSerializer,
    ScanJobSerializer,
    TaskSerializer,
    TopicDetailSerializer,
    TopicSerializer,
    WorkflowSerializer,
    artifact_type_for,
    file_metadata_payload,
)

logger = logging.getLogger(__name__)


def _profile_payload(user):
    profile = getattr(user, "profile", None)
    role = profile.role if profile else "user"
    return {
        "username": user.username,
        "display_name": user.get_full_name() or user.username,
        "role": role,
    }


def _settings_password_ok(supplied):
    """True when `supplied` is the hardcoded settings password
    (settings.SETTINGS_EDIT_PASSWORD). Constant-time compare, and an empty
    configured password never matches anything - it would otherwise leave
    Settings open to everyone."""
    expected = getattr(django_settings, "SETTINGS_EDIT_PASSWORD", "") or ""
    if not expected:
        return False
    return hmac.compare_digest(str(supplied or "").encode("utf-8"), expected.encode("utf-8"))


def _require_settings_password(request):
    """Returns a 403 Response unless the request carries the settings
    password (body field `settings_password`, or the X-Settings-Password
    header), else None. Replaces the old Admin/User role split now that the app
    has one shared login (Ayush, 8 Oct 2026): being signed in is not enough to
    change the API key or any other setting. Checked on the server on every
    save, so the Settings page's lock cannot be skipped from the browser."""
    supplied = request.data.get("settings_password") if hasattr(request.data, "get") else None
    if not supplied:
        supplied = request.headers.get("X-Settings-Password", "")
    if not _settings_password_ok(supplied):
        return Response(
            {"error": "The settings password is missing or wrong.", "code": "settings_password"}, status=403
        )
    return None

# The fixed question behind the topic page's "AI Context Brief" panel /
# "Refresh brief" button - asked through the exact same _ask_topic path as
# any other chat question (so it shows up in the chat log too, transparently
# - never a hidden call), just with wording aimed at the two fields that
# panel actually shows.
CONTEXT_BRIEF_QUESTION = "Give me the current state and the single best next step for this topic."


def _current_llm_settings():
    return {
        "llm_provider": Settings.get("llm_provider", "openrouter"),
        "llm_api_key": Settings.get("llm_api_key", ""),
        "llm_model": Settings.get("llm_model", "openai/gpt-5.4"),
        "llm_base_url": Settings.get("llm_base_url", "https://openrouter.ai/api/v1"),
        # Not LLM-related, but SettingsView.get() reuses this dict as its
        # response body, so the informational default_directory string rides
        # along here too - generate_brief() only ever .get()s the llm_* keys
        # it knows about, so this extra key is harmless to it.
        "default_directory": Settings.get("default_directory", ""),
        # How many days without a fresh brief/file before a topic is flagged
        # "stale" on the dashboard - PRD Should-have ("flag stale... information"),
        # admin-configurable since what counts as stale differs by project pace.
        "stale_after_days": Settings.get("stale_after_days", "14"),
        # The central Recordings-folder auto-transcribe pipeline (core/
        # recordings.py) - configurable from the Transcripts page, not the
        # main Settings page, but read/written through this same Settings
        # table/endpoint for consistency with everything else here.
        "recordings_watch_folder": Settings.get(
            "recordings_watch_folder", r"D:\OneDrive - Maarga Systems Private Limited\Recordings"
        ),
        # Whether the pipeline SUGGESTS a new project for a recording that
        # doesn't match anything existing - it never creates one silently;
        # a person always confirms or rejects on the Transcripts page (see
        # RecordingEvent's own docstring for why).
        "recordings_suggest_new_topics": Settings.get("recordings_suggest_new_topics", "true"),
        # Venki's own "common folder... shortcut to mark to projects" ask
        # (30 Sep) - a second, separate watched folder for manually-dropped
        # files (any type, not just recordings) that always land as
        # needs_review for a person to quick-tag, never auto-routed by an
        # LLM (core/recordings.py's tick_manual_drop_folder).
        "manual_drop_folder": Settings.get("manual_drop_folder", ""),
        # "local_whisper" (built-in, no setup) or "external" (POST the audio
        # file to external_transcription_url and expect back {"text":...,
        # "speakers": [...]?}) - the integration point for the engineering
        # team's transcript diarizer tool, or anything else, once it exists.
        "transcription_engine": Settings.get("transcription_engine", "local_whisper"),
        "external_transcription_url": Settings.get("external_transcription_url", ""),
    }


def _extract_and_store(ingested_file):
    """Runs meeting-metadata extraction over one IngestedFile's text and
    upserts (or clears) its ExtractedMeta row. No-op (and no error) when
    there's nothing usable to extract from yet - matches every call site's
    existing "don't let a bad file break the request" convention.

    Deterministic-first, no LLM for classification or most fields ("less
    LLM, more automation and code-based operation" - Ayush, 24 Sep):
    extraction.looks_like_meeting_transcript's real-signal gate (a transcript
    speaker line or an "Attendees:" header - never just the word "meeting"
    appearing anywhere, which is exactly the false positive a security
    review titled "Meeting Diarizer" hit before this) plus plain-regex
    title/date/time/attendees/agenda/achieved/hours extraction. This alone
    means a non-meeting file - most of what actually gets ingested - never
    reaches the LLM at all; previously every single file got a full
    classify+extract call regardless of what it was.

    Action items are the one thing regex genuinely can't pull reliably out
    of free-flowing meeting speech, so that's the one remaining LLM call -
    only for files already confirmed to look like a real meeting, and never
    fatal to storing everything else above if it fails."""
    # Document type / tags / signal / version / date (pure code, never
    # overwrites a human's value) - runs for every file, including unreadable
    # ones (those become state "error").
    doc_meta.safe_apply_auto_metadata(ingested_file)

    # Venki, 8 Oct: a file may be renamed to anything, so where the rules
    # cannot trust the NAME, an LLM reads the file's CONTENT and decides what
    # it is (only with a key configured; never overrides a person's choice).
    settings = _current_llm_settings()
    doc_meta.safe_refine_doc_type_with_llm(ingested_file, settings)

    text = ingested_file.extracted_text or ""
    if ingested_file.extraction_error or not text.strip():
        return

    # A file the content check identified as a meeting record is read as a
    # meeting even when it lacks the speaker-line shape the plain-code gate
    # looks for - that is how a renamed transcript or MoM reaches Meetings
    # and Action Items.
    read_as_meeting = extraction.looks_like_meeting_transcript(text) or (
        ingested_file.doc_type_source == "llm" and ingested_file.doc_type in doc_meta.MEETING_DOC_TYPES
    )
    if not read_as_meeting:
        ExtractedMeta.objects.filter(ingested_file=ingested_file).delete()
        Task.objects.filter(source_file=ingested_file).delete()
        return

    meta = extraction.extract_meeting_metadata(text)
    hours = extraction.extract_employee_hours(text)
    existing_meta = ExtractedMeta.objects.filter(ingested_file=ingested_file).first()
    defaults = {
        "meeting_title": meta["meeting_title"],
        "meeting_date": meta["meeting_date"],
        "meeting_time": meta["meeting_time"],
        "attendees": meta["attendees"],
        "agenda": meta["agenda"],
        "achieved": meta["achieved"],
        "employee_hours": hours,
    }
    # Meeting type/sequence (a manual choice is kept) + "who said what" turns.
    defaults.update(
        doc_meta.auto_meeting_fields(
            meta["meeting_title"], doc_meta.primary_filename(ingested_file), text, existing_meta
        )
    )
    ExtractedMeta.objects.update_or_create(ingested_file=ingested_file, defaults=defaults)

    if not settings.get("llm_api_key"):
        return
    try:
        action_items = llm_brief.extract_action_items_llm(text, meta["meeting_date"], settings)
    except Exception:  # noqa: BLE001 - action items are a bonus, never fatal
        return

    # Add any action items not already created from this same file - never
    # touches an existing task's status/due_date, so re-scanning doesn't
    # reset progress someone already made on the board.
    existing_titles = set(
        Task.objects.filter(source_file=ingested_file).values_list("title", flat=True)
    )
    for item in action_items:
        title = (item.get("title") or "").strip()
        if not title or title in existing_titles:
            continue
        # No due date is stored (Ayush, 8 Oct: an action item is just the
        # action plus the date it was added - created_at - and where it came
        # from). A date the model inferred from the meeting wording was only
        # ever a guess.
        Task.objects.create(
            topic=ingested_file.topic,
            source_file=ingested_file,
            title=title,
            assignee=item.get("assignee") or "",
        )


# The 7 structured brief fields, shared by _ask_topic (persisting
# field_sources), the CSV export/import actions, and _brief_html_page's
# per-paragraph rendering - one list so all three can't drift apart.
SUMMARY_FIELD_NAMES = [
    "why_now", "current_state", "history", "customer_thoughts",
    "customer_need", "proposed_solution", "latest_updates", "decisions_made", "meeting_prep",
    "promises_made", "next_step", "risks_and_gaps",
]


def _message_payload(msg):
    return {
        "id": msg.id,
        "content": msg.content,
        "source_files": msg.source_files,
        "is_llm": msg.is_llm,
        "generation_note": msg.generation_note,
        "created_at": msg.created_at,
    }


def _ask_topic(topic, question):
    """Shared core of TopicViewSet.ask(): records the user's question, asks
    llm_brief for a brief grounded in this topic's ingested files, records
    the assistant's reply, and returns the exact dict the /ask/ endpoint has
    always returned as its Response body. Pulled out so OrientView can reuse
    the identical behavior once it has already resolved which topic a
    free-text request belongs to.

    A correction command ("remove Rinky", "rename X to Y") is detected and
    applied FIRST, before any LLM call - see corrections.py's own docstring
    for why this is plain pattern matching rather than an LLM classification
    step. When one matches, this topic's own data is mutated directly and
    the chat just reports what changed - no brief is generated for that
    turn at all."""
    ChatMessage.objects.create(topic=topic, role="user", content=question, is_llm=False)

    correction = corrections.detect_correction(question)
    if correction:
        if correction["action"] == "remove_attendee":
            reply, _changed = corrections.apply_removal(topic, correction["name"])
        else:
            reply, _changed = corrections.apply_rename(topic, correction["old"], correction["new"])
        msg = ChatMessage.objects.create(
            topic=topic,
            role="assistant",
            content=reply,
            source_files=[],
            is_llm=False,
            generation_note="Applied directly as a data correction - no LLM call needed for this.",
        )
        return _message_payload(msg)

    files = list(topic.files.all())
    answer, source_paths, is_llm, note, fields = llm_brief.generate_brief(
        topic, question, files, settings=_current_llm_settings()
    )
    # Resolve raw paths back to their file records so the reference
    # timestamp travels with the citation, not just a bare filename.
    by_path = {f.path: f for f in files}
    sources = [
        {
            "id": by_path[p].id,
            "path": p,
            "display_name": by_path[p].display_name or p,
            "first_added_at": by_path[p].first_added_at.isoformat(),
        }
        for p in source_paths
        if p in by_path
    ]
    msg = ChatMessage.objects.create(
        topic=topic,
        role="assistant",
        content=answer,
        source_files=sources,
        is_llm=is_llm,
        generation_note=note or "",
    )
    # A real (non-small-talk) brief also becomes this topic's latest AI
    # Context Brief - the topic page's brief panel shows this without
    # needing its own separate question asked first. Fresh row every time,
    # never updated in place - see CaseSummary's own docstring for why.
    if fields and not fields.get("is_conversational"):
        field_sources = {
            key: [p for p in (fields.get(f"{key}_sources") or []) if isinstance(p, str)]
            for key in SUMMARY_FIELD_NAMES
        }
        CaseSummary.objects.create(
            topic=topic,
            answer_summary=fields.get("answer_summary") or "",
            # One dict built straight from SUMMARY_FIELD_NAMES instead of a
            # field-by-field list - a new section only ever needs adding in
            # that one list (and the model/schema), never here too.
            **{key: fields.get(key) or "" for key in SUMMARY_FIELD_NAMES},
            field_sources=field_sources,
            sources_used=source_paths,
        )
    return _message_payload(msg)


def _ask_global(question):
    """The 'common chatbox' equivalent of _ask_topic: grounded in every
    ingested file across every topic at once, so a question like "what's
    going on everywhere" doesn't need picking a topic first. Persists to
    GlobalChatMessage instead of a per-topic ChatMessage."""
    GlobalChatMessage.objects.create(role="user", content=question, is_llm=False)

    files = list(IngestedFile.objects.exclude(extracted_text="").select_related("topic"))
    answer, source_paths, is_llm, note, _fields = llm_brief.generate_brief(
        None, question, files, settings=_current_llm_settings()
    )
    by_path = {f.path: f for f in files}
    sources = [
        {
            "path": p,
            "display_name": by_path[p].display_name or p,
            "topic_name": by_path[p].topic.name,
            "first_added_at": by_path[p].first_added_at.isoformat(),
        }
        for p in source_paths
        if p in by_path
    ]
    msg = GlobalChatMessage.objects.create(
        role="assistant",
        content=answer,
        source_files=sources,
        is_llm=is_llm,
        generation_note=note or "",
    )
    return _message_payload(msg)


class MessageFeedbackView(APIView):
    """Thumbs up/down on one assistant message - the "orientation run"
    capture Venki asked for directly (30 Sep AI Adoption Sprint Meeting):
    "I should be able to say thumbs up or thumbs down... it should be
    unobtrusive". `kind` is "topic" (ChatMessage) or "global"
    (GlobalChatMessage) - one endpoint for both rather than two near-
    identical views, since the shape and rule (assistant messages only)
    are identical."""

    def post(self, request, kind, pk):
        model = ChatMessage if kind == "topic" else GlobalChatMessage
        msg = get_object_or_404(model, pk=pk)
        if msg.role != "assistant":
            return Response({"error": "Feedback only applies to assistant messages."}, status=400)
        value = request.data.get("feedback", "")
        if value not in ("", "up", "down"):
            return Response({"error": "feedback must be 'up', 'down', or '' to clear it."}, status=400)
        msg.feedback = value
        msg.save(update_fields=["feedback"])
        serializer_cls = ChatMessageSerializer if kind == "topic" else GlobalChatMessageSerializer
        return Response(serializer_cls(msg).data)


class GlobalChatView(APIView):
    """The common chatbox - GET returns the persisted history, POST asks a
    new question grounded across every topic's ingested files at once."""

    def get(self, request):
        messages = GlobalChatMessage.objects.all()
        return Response(GlobalChatMessageSerializer(messages, many=True).data)

    def post(self, request):
        question = (request.data.get("question") or "").strip()
        if not question:
            return Response({"error": "question is required"}, status=400)
        return Response(_ask_global(question))

    def delete(self, request):
        GlobalChatMessage.objects.all().delete()
        return Response(status=204)


def _start_scan_job(topic, work_fn):
    """Runs work_fn(topic, on_progress) in a background thread and returns a
    ScanJob id immediately, instead of a bulk operation blocking one HTTP
    request with zero feedback until it finally finishes. Shared by every
    bulk data-fetch action (folder scan, folder upload, mbox import, ics
    import) so each one doesn't re-implement the same thread/job
    bookkeeping - poll scan_status with the returned id for progress.

    work_fn receives (topic, on_progress) where on_progress(done, total,
    status=None) updates the job's progress (and status, e.g. switching
    from "scanning" to "extracting" mid-run). work_fn's return value, if a
    dict, is merged into the job's fields on success (e.g. scanned/updated/
    unchanged counts)."""
    job = ScanJob.objects.create(topic=topic, status="scanning")
    topic_id = topic.id
    job_id = job.id

    def run():
        try:
            def on_progress(done, total, status=None):
                fields = {"processed_files": done, "total_files": total}
                if status:
                    fields["status"] = status
                ScanJob.objects.filter(id=job_id).update(**fields)

            t = Topic.objects.get(id=topic_id)
            extra = work_fn(t, on_progress) or {}
            ScanJob.objects.filter(id=job_id).update(status="done", finished_at=timezone.now(), **extra)
        except Exception as exc:  # noqa: BLE001 - report it on the job, don't crash the thread silently
            ScanJob.objects.filter(id=job_id).update(
                status="error", error_message=str(exc)[:500], finished_at=timezone.now()
            )
        finally:
            connection.close()

    threading.Thread(target=run, daemon=True).start()
    return job.id


class TopicViewSet(viewsets.ModelViewSet):
    queryset = Topic.objects.all()
    parser_classes = [JSONParser, MultiPartParser, FormParser]

    def get_serializer_class(self):
        if self.action == "retrieve":
            return TopicDetailSerializer
        return TopicSerializer

    @action(detail=True, methods=["post"])
    def add_folder(self, request, pk=None):
        topic = self.get_object()
        path = (request.data.get("path") or "").strip()
        if not path:
            return Response({"error": "path is required"}, status=400)
        folder = SourceFolder.objects.create(topic=topic, path=path)
        return Response({"id": folder.id, "path": folder.path})

    @action(detail=True, methods=["post"])
    def ingest(self, request, pk=None):
        """Kicks off the scan in a background thread and returns immediately
        with a job id - a bulk folder (dozens of files, each possibly a slow
        LLM call) used to mean one long blocking request with zero feedback
        until it finally returned. The frontend polls scan_status for real
        progress and refreshes the moment it's done, instead of a manual
        reload."""
        topic = self.get_object()
        folder_paths = [f.path for f in topic.folders.all()]

        def work(t, on_progress):
            summary = {"scanned": 0, "added": 0, "updated": 0, "unchanged": 0, "errors": []}
            for folder_path in folder_paths:
                result = ingestion.ingest_folder(
                    t, folder_path, on_progress=lambda d, tot: on_progress(d, tot, status="scanning")
                )
                summary["scanned"] += result["scanned"]
                summary["added"] += result["added"]
                summary["updated"] += result["updated"]
                summary["unchanged"] += result["unchanged"]
                summary["errors"].extend(result["errors"])

            # Re-run extraction over every file with text that's missing or
            # has outdated ExtractedMeta - "outdated" meaning the file was
            # re-ingested (a real content_hash change) more recently than its
            # meta was last computed. This is the slow phase (one LLM call
            # per file that needs it), so it's the one the progress bar
            # mostly reflects.
            to_extract = []
            for f in t.files.all():
                if not (f.extracted_text or "").strip() or f.extraction_error:
                    continue
                existing_meta = getattr(f, "meta", None)
                if existing_meta is None or f.last_ingested_at > existing_meta.extracted_at:
                    to_extract.append(f)

            on_progress(0, len(to_extract), status="extracting")
            for i, f in enumerate(to_extract, 1):
                _extract_and_store(f)
                on_progress(i, len(to_extract))

            # Pre-compile the brief here, in the background, rather than
            # live when someone opens the Context Node ("less LLM... more
            # code-based operation" + Venki's own 10-second/deterministic
            # framing, 24 Sep) - opening the page is then a plain DB read,
            # never a wait on a live LLM call. Only worth it if something
            # actually changed; skip entirely on an unchanged re-scan.
            if summary["added"] or summary["updated"]:
                on_progress(len(to_extract), len(to_extract), status="extracting")
                _ask_topic(t, CONTEXT_BRIEF_QUESTION)

            return {
                "scanned": summary["scanned"],
                "added": summary["added"],
                "updated": summary["updated"],
                "unchanged": summary["unchanged"],
            }

        job_id = _start_scan_job(topic, work)
        return Response({"job_id": job_id})

    @action(detail=True, methods=["get"], url_path="scan_status")
    def scan_status(self, request, pk=None):
        topic = self.get_object()
        job = topic.scan_jobs.first()  # ScanJob.Meta.ordering = ["-started_at"]
        if not job:
            return Response({"status": "idle"})
        return Response(ScanJobSerializer(job).data)

    @action(detail=True, methods=["post"])
    def upload_file(self, request, pk=None):
        """Data-fetch option 2: upload one file directly, no folder needed -
        for a one-off document you don't want to set up a whole lookup
        folder just to add. Captures the same first_added_at reference
        timestamp as folder ingestion.

        Audio/video recordings are the one exception: transcription can
        take minutes for a real meeting, so those go through the same
        background-job pattern as a folder scan (returns {"job_id": ...}
        instead of {"id": ...}) rather than blocking the HTTP request -
        the frontend distinguishes the two response shapes and polls
        scan_status for the async case."""
        topic = self.get_object()
        upload = request.FILES.get("file")
        if not upload:
            return Response({"error": "file is required"}, status=400)

        upload_dir = os.path.join(django_settings.MEDIA_ROOT, f"topic_{topic.id}", "uploads")
        os.makedirs(upload_dir, exist_ok=True)
        dest_path = os.path.join(upload_dir, upload.name)

        raw = upload.read()
        with open(dest_path, "wb") as f:
            f.write(raw)
        content_hash = hashlib.sha256(raw).hexdigest()

        ext = os.path.splitext(upload.name)[1].lower()
        if ext in (".mp4", ".mov", ".webm", ".wav", ".mp3", ".m4a"):
            def work(t, on_progress):
                on_progress(0, 1, status="extracting")
                try:
                    text = ingestion.extract_text(dest_path)
                    error = ""
                except Exception as e:  # noqa: BLE001 - report it on the file, not a 500
                    text = ""
                    error = str(e)
                obj, _ = IngestedFile.objects.update_or_create(
                    topic=t,
                    path=dest_path,
                    defaults={
                        "display_name": upload.name,
                        "source_method": "upload",
                        "extracted_text": text,
                        "content_hash": content_hash,
                        "extraction_error": error,
                    },
                )
                _extract_and_store(obj)
                on_progress(1, 1)
                return {"scanned": 1, "added": 1, "updated": 0, "unchanged": 0}

            job_id = _start_scan_job(topic, work)
            return Response({"job_id": job_id})

        try:
            text = ingestion.extract_text(dest_path)
            error = ""
        except Exception as e:  # noqa: BLE001 - report it, don't 500 the request
            text = ""
            error = str(e)

        obj, _ = IngestedFile.objects.update_or_create(
            topic=topic,
            path=dest_path,
            defaults={
                "display_name": upload.name,
                "source_method": "upload",
                "extracted_text": text,
                "content_hash": content_hash,
                "extraction_error": error,
            },
        )
        _extract_and_store(obj)
        return Response({"id": obj.id, "display_name": obj.display_name, "error": error})

    @action(detail=True, methods=["post"])
    def upload_folder(self, request, pk=None):
        """Data-fetch option 4: upload a whole local folder at once (the
        frontend sends each File's webkitRelativePath alongside it) - for
        adding a folder's worth of files without setting up a lookup-folder
        scan path on the server. Backgrounded the same way as ingest/scan -
        see _start_scan_job - since a folder can be dozens of files, each
        possibly a slow LLM extraction call."""
        topic = self.get_object()
        files = request.FILES.getlist("files")
        paths = request.POST.getlist("paths")
        if not files:
            return Response({"error": "files is required"}, status=400)

        # Read every file's bytes now, synchronously - request.FILES doesn't
        # survive into a background thread, but plain bytes do.
        items = [((paths[i] if i < len(paths) else upload.name) or upload.name, upload.read()) for i, upload in enumerate(files)]
        base_dir = os.path.join(django_settings.MEDIA_ROOT, f"topic_{topic.id}", "folder_upload")

        def work(t, on_progress):
            uploaded = 0
            errors = []
            on_progress(0, len(items), status="extracting")
            for i, (relpath, raw) in enumerate(items, 1):
                # Sanitize: drop any ".."/"." segment and empty parts
                # (leading/trailing slashes) to prevent writing outside base_dir.
                safe_parts = [p for p in relpath.replace("\\", "/").split("/") if p not in ("", ".", "..")]
                rel_safe = os.path.join(*safe_parts) if safe_parts else relpath
                dest_path = os.path.join(base_dir, rel_safe)
                try:
                    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                    with open(dest_path, "wb") as f:
                        f.write(raw)
                    content_hash = hashlib.sha256(raw).hexdigest()

                    try:
                        text = ingestion.extract_text(dest_path)
                        error = ""
                    except Exception as e:  # noqa: BLE001 - report it, don't abort the whole upload
                        text = ""
                        error = str(e)

                    obj, _ = IngestedFile.objects.update_or_create(
                        topic=t,
                        path=dest_path,
                        defaults={
                            "display_name": relpath,
                            "source_method": "folder_upload",
                            "extracted_text": text,
                            "content_hash": content_hash,
                            "extraction_error": error,
                        },
                    )
                    _extract_and_store(obj)
                    if error:
                        errors.append(f"{relpath}: {error}")
                    else:
                        uploaded += 1
                except Exception as e:  # noqa: BLE001 - one bad file shouldn't abort the whole upload
                    errors.append(f"{relpath}: {e}")
                on_progress(i, len(items))

            return {"updated": uploaded, "error_message": "; ".join(errors[:5])[:500]}

        job_id = _start_scan_job(topic, work)
        return Response({"job_id": job_id})

    @action(detail=True, methods=["post"])
    def paste_text(self, request, pk=None):
        """Data-fetch option 3: paste text directly (an email body, a quick
        note) - no file, no folder, just captured with the same reference
        timestamp as any other ingested content."""
        topic = self.get_object()
        text = (request.data.get("text") or "").strip()
        label = (request.data.get("label") or "").strip()
        if not text:
            return Response({"error": "text is required"}, status=400)

        display_name = label or f"Pasted note ({uuid.uuid4().hex[:6]})"
        synthetic_path = f"pasted:{uuid.uuid4()}"

        obj = IngestedFile.objects.create(
            topic=topic,
            path=synthetic_path,
            display_name=display_name,
            source_method="paste",
            extracted_text=text,
            content_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        )
        _extract_and_store(obj)
        return Response({"id": obj.id, "display_name": obj.display_name})

    @action(detail=True, methods=["post"], url_path="import_mbox")
    def import_mbox(self, request, pk=None):
        """Data-fetch option: Email export (.mbox) - one IngestedFile per
        message in the mbox, each independently askable/citable like any
        other ingested file. .pst is not supported - it needs a real
        third-party parser with no stdlib equivalent, a separate piece of
        work, not something to fake."""
        topic = self.get_object()
        upload = request.FILES.get("file")
        if not upload:
            return Response({"error": "file is required"}, status=400)
        try:
            messages = mbox_import.parse_mbox_bytes(upload.read())
        except Exception as exc:  # noqa: BLE001 - report a bad file, don't 500
            return Response({"error": f"Could not parse .mbox file: {exc}"}, status=400)

        def work(t, on_progress):
            created = 0
            on_progress(0, len(messages), status="extracting")
            for i, msg in enumerate(messages, 1):
                text = (
                    f"From: {msg['from']}\nTo: {msg['to']}\nDate: {msg['date']}\n"
                    f"Subject: {msg['subject']}\n\n{msg['body']}"
                )
                obj = IngestedFile.objects.create(
                    topic=t,
                    path=f"mbox:{uuid.uuid4()}",
                    display_name=msg["subject"],
                    source_method="email_import",
                    extracted_text=text,
                    content_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
                )
                _extract_and_store(obj)
                created += 1
                on_progress(i, len(messages))
            return {"updated": created}

        job_id = _start_scan_job(topic, work)
        return Response({"job_id": job_id})

    @action(detail=True, methods=["post"], url_path="import_ics")
    def import_ics(self, request, pk=None):
        """Data-fetch option: Calendar export (.ics) - one IngestedFile PLUS
        a directly-populated ExtractedMeta per VEVENT, since the calendar
        file already gives real structured fields (title/date/attendees)
        that would otherwise have to be guessed by the LLM/heuristic
        extractor - skipping the guess entirely is strictly more accurate
        here."""
        topic = self.get_object()
        upload = request.FILES.get("file")
        if not upload:
            return Response({"error": "file is required"}, status=400)
        try:
            events = [ev for ev in ics_import.parse_ics(upload.read().decode("utf-8", errors="replace")) if ev["start"]]
        except Exception as exc:  # noqa: BLE001 - report a bad file, don't 500
            return Response({"error": f"Could not parse .ics file: {exc}"}, status=400)

        def work(t, on_progress):
            created = 0
            on_progress(0, len(events), status="extracting")
            for i, ev in enumerate(events, 1):
                summary = ev["summary"] or "(untitled event)"
                lines = [f"Meeting: {summary}", f"Date: {ev['start'].date().isoformat()}"]
                if ev["location"]:
                    lines.append(f"Location: {ev['location']}")
                if ev["attendees"]:
                    lines.append(f"Attendees: {', '.join(ev['attendees'])}")
                if ev["description"]:
                    lines.append(f"\n{ev['description']}")
                text = "\n".join(lines)

                obj = IngestedFile.objects.create(
                    topic=t,
                    path=f"ics:{uuid.uuid4()}",
                    display_name=summary,
                    source_method="calendar_import",
                    extracted_text=text,
                    content_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
                )
                ExtractedMeta.objects.update_or_create(
                    ingested_file=obj,
                    defaults={
                        "meeting_title": summary,
                        "meeting_date": ev["start"].date(),
                        "meeting_time": ev["start"].strftime("%I:%M %p").lstrip("0") if ev["start"].time() else "",
                        "attendees": ev["attendees"],
                        "agenda": (ev["description"] or "")[:500],
                        "achieved": "",
                        "employee_hours": [],
                        **doc_meta.auto_meeting_fields(summary, "", "", None),
                    },
                )
                doc_meta.safe_apply_auto_metadata(obj)
                created += 1
                on_progress(i, len(events))
            return {"updated": created}

        job_id = _start_scan_job(topic, work)
        return Response({"job_id": job_id})

    @action(detail=True, methods=["post"])
    def ask(self, request, pk=None):
        topic = self.get_object()
        question = (request.data.get("question") or "").strip()
        if not question:
            return Response({"error": "question is required"}, status=400)
        return Response(_ask_topic(topic, question))

    @action(detail=True, methods=["delete"], url_path="clear_chat")
    def clear_chat(self, request, pk=None):
        topic = self.get_object()
        topic.messages.all().delete()
        return Response(status=204)

    @action(detail=True, methods=["get"], url_path="latest_summary")
    def latest_summary(self, request, pk=None):
        """The topic page's 'AI Context Brief' panel - whatever the most
        recently generated CaseSummary is (from any chat question, or a
        manual "Refresh brief"), or null if none exists yet."""
        topic = self.get_object()
        summary = topic.summaries.first()  # CaseSummary.Meta.ordering = ["-generated_at"]
        # {} rather than None/null - DRF's JSONRenderer renders None as an
        # EMPTY body (not the string "null"), which breaks a plain
        # `res.json()` on the frontend. {} is valid, non-empty JSON; the
        # frontend treats a missing `generated_at` as "no brief yet".
        if not summary:
            return Response({})
        return Response(CaseSummarySerializer(summary).data)

    @action(detail=True, methods=["get"], url_path="summary_history")
    def summary_history(self, request, pk=None):
        """Every status-update brief ever generated for this topic, oldest
        first - unlike latest_summary (just the newest one), this is what
        the timeline uses to show how the project's own understood state
        changed over time, not just where it stands right now."""
        topic = self.get_object()
        summaries = topic.summaries.all().order_by("generated_at")
        data = CaseSummarySerializer(summaries, many=True).data
        # Attach the same specific-headline logic the Wox/Raycast HTML brief
        # page already uses (_summary_timeline_entry) - the dashboard's own
        # Project Timeline previously computed a generic "Status update:
        # <current_state>" label independently in JS, which never picked up
        # that earlier fix and left the timeline flooded with near-identical
        # entries (real feedback: "many things are same only... confusing").
        for row, s in zip(data, summaries):
            title, body = _summary_timeline_entry(s)
            row["timeline_title"] = title
            row["timeline_body"] = body
        return Response(data)

    @action(detail=True, methods=["get"], url_path="workflow_history")
    def workflow_history(self, request, pk=None):
        """Every payroll-approval run for this topic, oldest first - same
        reasoning as summary_history: the timeline needs the full history,
        not just whatever's accumulated in the current browser session."""
        topic = self.get_object()
        workflows = topic.workflows.all().order_by("created_at")
        return Response(WorkflowSerializer(workflows, many=True).data)

    @action(detail=True, methods=["get"], url_path="export_brief_md")
    def export_brief_md(self, request, pk=None):
        """Venki's own stated editing preference, not a custom in-app editor:
        'standard tools for me is Markdown and CSV... I access it using the
        raycast surface.' This writes the current AI Context Brief as a real
        .md file - downloaded, and also dropped straight into the topic's
        own folder if it has one, so it sits right alongside the real files
        and gets picked up as context on the next scan. Deliberately one-way
        (export only, no markdown-parsing re-import): Venki's own words -
        'Markdown is not precise' - so edits feed back in loosely as context
        for the next AI-generated brief, not as a strict field-by-field
        parse back into the CaseSummary row."""
        topic = self.get_object()
        summary = topic.summaries.first()
        lines = [f"# {topic.name}", ""]
        if summary:
            for label, field in [
                ("Why now", "why_now"),
                ("Current state", "current_state"),
                ("History", "history"),
                ("Customer perspective", "customer_thoughts"),
                ("Commitments and open loops", "promises_made"),
                ("Next step", "next_step"),
                ("Risks and gaps", "risks_and_gaps"),
            ]:
                value = getattr(summary, field)
                if value:
                    lines.append(f"## {label}")
                    lines.append(value)
                    lines.append("")
        else:
            lines.append("_No AI Context Brief generated yet._")
        content = "\n".join(lines)

        folder = topic.folders.first()
        if folder and os.path.isdir(folder.path):
            try:
                with open(os.path.join(folder.path, "orientme-brief.md"), "w", encoding="utf-8") as f:
                    f.write(content)
            except OSError:
                pass  # download still works even if the folder write fails

        response = HttpResponse(content, content_type="text/markdown; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="{topic.name}-brief.md"'
        return response

    @action(detail=True, methods=["get"], url_path="export_tasks_csv")
    def export_tasks_csv(self, request, pk=None):
        """The CSV half of the same preference - CSV is 'precise' (his own
        word), so unlike the markdown brief, this one round-trips for real
        (see import_tasks_csv)."""
        import csv
        import io

        topic = self.get_object()
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "title", "assignee", "due_date", "status"])
        for t in topic.tasks.all():
            writer.writerow([t.id, t.title, t.assignee, t.due_date.isoformat() if t.due_date else "", t.status])
        content = buf.getvalue()

        folder = topic.folders.first()
        if folder and os.path.isdir(folder.path):
            try:
                with open(os.path.join(folder.path, "orientme-tasks.csv"), "w", encoding="utf-8", newline="") as f:
                    f.write(content)
            except OSError:
                pass

        response = HttpResponse(content, content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="{topic.name}-tasks.csv"'
        return response

    @action(detail=True, methods=["post"], url_path="import_tasks_csv")
    def import_tasks_csv(self, request, pk=None):
        """Reads an edited copy of export_tasks_csv's own output back in -
        matches rows by the id column (never by title, which someone may
        have edited) and updates title/assignee/due_date/status. Rows whose
        id isn't a real task on this topic are skipped, not created - this
        is for editing existing tasks with a spreadsheet, not bulk-creating
        new ones."""
        import csv
        import io

        topic = self.get_object()
        upload = request.FILES.get("file")
        if not upload:
            return Response({"error": "file is required"}, status=400)

        try:
            text = upload.read().decode("utf-8-sig")
        except UnicodeDecodeError:
            return Response({"error": "Could not read file as UTF-8 CSV"}, status=400)

        reader = csv.DictReader(io.StringIO(text))
        tasks_by_id = {t.id: t for t in topic.tasks.all()}
        updated, skipped = 0, 0
        for row in reader:
            try:
                task_id = int((row.get("id") or "").strip())
            except (TypeError, ValueError):
                skipped += 1
                continue
            task = tasks_by_id.get(task_id)
            if not task:
                skipped += 1
                continue
            task.title = (row.get("title") or task.title).strip()
            task.assignee = (row.get("assignee") or "").strip()
            due_date = (row.get("due_date") or "").strip()
            task.due_date = due_date or None
            status_value = (row.get("status") or "").strip()
            if status_value in dict(TASK_STATUSES):
                task.status = status_value
            task.save()
            updated += 1

        return Response({"updated": updated, "skipped": skipped})

    # Field/label pairs shared by export_summary_csv and import_summary_csv -
    # one source of truth for which CaseSummary columns are CSV-editable and
    # what to call them in the sheet.
    SUMMARY_CSV_FIELDS = [
        ("why_now", "Why now"),
        ("current_state", "Current state"),
        ("history", "History"),
        ("customer_thoughts", "Customer perspective"),
        ("promises_made", "Commitments and open loops"),
        ("next_step", "Next step"),
        ("risks_and_gaps", "Risks and gaps"),
    ]

    @action(detail=True, methods=["get"], url_path="export_summary_csv")
    def export_summary_csv(self, request, pk=None):
        """The CSV half of the brief, matching export_tasks_csv's pattern:
        Venki's own words, 22 Sep sprint - AI does 'first level creation',
        then 'I edit on top of it... using standard tools, standard tools
        for me is Markdown and CSV... backend should be JSON, CSV, Markdown
        is not precise.' export_brief_md is the Markdown (human-readable,
        one-way) half; this is the CSV (precise, round-trips for real) half
        - see import_summary_csv."""
        import csv
        import io

        topic = self.get_object()
        summary = topic.summaries.first()
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["field", "label", "value"])
        for field, label in self.SUMMARY_CSV_FIELDS:
            value = getattr(summary, field) if summary else ""
            writer.writerow([field, label, value])
        content = buf.getvalue()

        folder = topic.folders.first()
        if folder and os.path.isdir(folder.path):
            try:
                with open(os.path.join(folder.path, "orientme-brief-fields.csv"), "w", encoding="utf-8", newline="") as f:
                    f.write(content)
            except OSError:
                pass

        response = HttpResponse(content, content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="{topic.name}-brief.csv"'
        return response

    @action(detail=True, methods=["post"], url_path="import_summary_csv")
    def import_summary_csv(self, request, pk=None):
        """Reads an edited copy of export_summary_csv's own output back in -
        matches rows by the 'field' column (never 'label', which someone may
        have reworded), and writes a NEW CaseSummary row rather than mutating
        the latest one in place, keeping this model's existing 'fresh row per
        generation, full history kept' pattern (summary_history, the Project
        Timeline) intact. is_manual_edit=True marks it as a person's edit on
        top of the AI's draft, not a fresh AI generation - the two-part
        'creation part, editing part' split from the 22 Sep transcript."""
        import csv
        import io

        topic = self.get_object()
        upload = request.FILES.get("file")
        if not upload:
            return Response({"error": "file is required"}, status=400)

        base = topic.summaries.first()
        if not base:
            return Response(
                {"error": "No brief exists yet to edit - generate one first (ask a question, or Refresh brief)."},
                status=400,
            )

        try:
            text = upload.read().decode("utf-8-sig")
        except UnicodeDecodeError:
            return Response({"error": "Could not read file as UTF-8 CSV"}, status=400)

        values = {field: getattr(base, field) for field, _label in self.SUMMARY_CSV_FIELDS}
        valid_fields = dict(self.SUMMARY_CSV_FIELDS)
        updated, skipped = 0, 0
        for row in csv.DictReader(io.StringIO(text)):
            field = (row.get("field") or "").strip()
            if field not in valid_fields:
                skipped += 1
                continue
            values[field] = row.get("value") or ""
            updated += 1

        new_summary = CaseSummary.objects.create(
            topic=topic,
            sources_used=base.sources_used,
            is_manual_edit=True,
            **values,
        )
        return Response({
            "updated": updated,
            "skipped": skipped,
            "summary": CaseSummarySerializer(new_summary).data,
        })

    @action(detail=True, methods=["post"], url_path="refresh_summary")
    def refresh_summary(self, request, pk=None):
        """Manually regenerate the brief on demand, via the exact same ask
        pipeline as any other question (so it's transparent in the chat log,
        not a hidden call) - see CONTEXT_BRIEF_QUESTION.

        Accepts an optional `question` in the POST body so the Smart
        Suggestions preset buttons ("Catch me up", "What's changed?",
        "Prepare me for next meeting") can each regenerate the same on-page
        brief with a differently-focused question, without reintroducing a
        chat surface - falls back to the original fixed question when absent."""
        topic = self.get_object()
        question = (request.data.get("question") or "").strip() or CONTEXT_BRIEF_QUESTION
        _ask_topic(topic, question)
        summary = topic.summaries.first()
        if not summary:
            return Response(
                {"error": "Could not generate a brief yet - add some files to this project first."},
                status=400,
            )
        return Response(CaseSummarySerializer(summary).data)

    @action(detail=True, methods=["get", "patch"], url_path="state")
    def project_state(self, request, pk=None):
        """The explicit 'Project Intelligence' current-position editor -
        distinct from CaseSummary (AI-regenerated, append-only). GET
        get-or-creates the one row for this topic; PATCH shifts the old
        current_position into previous_position before overwriting, so one
        prior value is always available without a full history table."""
        topic = self.get_object()
        state, _created = ProjectState.objects.get_or_create(topic=topic)
        if request.method == "GET":
            return Response(ProjectStateSerializer(state).data)

        new_position = request.data.get("current_position", "")
        state.previous_position = state.current_position
        state.current_position = new_position
        state.updated_by = request.user.get_full_name() or request.user.username
        state.save()
        return Response(ProjectStateSerializer(state).data)

    @action(detail=True, methods=["get"])
    def meeting_metadata(self, request, pk=None):
        """Meetings of this topic (deduplicated), newest first. Every key it
        always returned is still here; added (5 Oct 2026): file_id,
        meeting_type(+label/source), meeting_sequence, speaker_turn_count,
        speaker_summary ("who said what" per speaker) and notes. Pass
        ?include_turns=1 to also get the full speaker_turns list."""
        topic = self.get_object()
        include_turns = request.query_params.get("include_turns") in ("1", "true", "yes")
        metas = (
            ExtractedMeta.objects.filter(ingested_file__topic=topic)
            .select_related("ingested_file")
            .prefetch_related("notes")
            .order_by(F("meeting_date").desc(nulls_last=True), "-ingested_file__first_added_at")
        )
        return Response([_meeting_payload(m, include_turns=include_turns) for m in _dedupe_meetings(metas)])

    @action(detail=True, methods=["get"], url_path="timeline_events")
    def timeline_events(self, request, pk=None):
        """Business timeline, oldest first: meetings (with type + sequence),
        emails, key documents (proposal / quotation-SOW / PRD-BRD / charter /
        plan, with version) and human notes."""
        return Response(_business_timeline_events(self.get_object()))

    @action(detail=True, methods=["get"], url_path="metadata_csv")
    def metadata_csv(self, request, pk=None):
        """Metadata CSV for this topic's files: the 7 contract columns
        (file, document_type, topic_tags, signal, state, seconds,
        review_notes) first, then phase, version, doc_date, participants."""
        topic = self.get_object()
        files = topic.files.select_related("topic", "meta").prefetch_related("topic__folders")
        return _metadata_csv_response(files, f"{topic.name}-metadata.csv")

    # ---- human notes (MeetingNote) ----------------------------------------
    @action(detail=True, methods=["get", "post"], url_path="notes")
    def notes(self, request, pk=None):
        topic = self.get_object()
        if request.method == "GET":
            qs = topic.meeting_notes.select_related("meta")
            meta_id = request.query_params.get("meta")
            if meta_id:
                qs = qs.filter(meta_id=meta_id)
            return Response(MeetingNoteSerializer(qs, many=True).data)

        text = str(request.data.get("text") or "").strip()
        if not text:
            return Response({"error": "text is required"}, status=400)
        if len(text) > MAX_NOTE_LENGTH:
            return Response({"error": f"A note can be at most {MAX_NOTE_LENGTH} characters."}, status=400)
        meta = None
        raw_meta = request.data.get("meta")
        if raw_meta not in (None, ""):
            meta = ExtractedMeta.objects.filter(pk=raw_meta, ingested_file__topic=topic).first()
            if meta is None:
                return Response({"error": "That meeting does not belong to this topic."}, status=400)
        note = MeetingNote.objects.create(topic=topic, meta=meta, text=text, author=request.user.username)
        return Response(MeetingNoteSerializer(note).data, status=201)

    @action(detail=True, methods=["patch", "delete"], url_path=r"notes/(?P<note_id>\d+)")
    def note_detail(self, request, pk=None, note_id=None):
        topic = self.get_object()
        note = get_object_or_404(MeetingNote, pk=note_id, topic=topic)
        if request.method == "DELETE":
            note.delete()
            return Response(status=204)
        text = str(request.data.get("text") or "").strip()
        if not text:
            return Response({"error": "text is required"}, status=400)
        if len(text) > MAX_NOTE_LENGTH:
            return Response({"error": f"A note can be at most {MAX_NOTE_LENGTH} characters."}, status=400)
        note.text = text
        note.save(update_fields=["text"])
        return Response(MeetingNoteSerializer(note).data)

    # ---- contacts (optional role / side per stakeholder) ------------------
    def _attendee_suggestions(self, topic):
        metas = list(ExtractedMeta.objects.filter(ingested_file__topic=topic))
        saved = {c.name.lower() for c in topic.contacts.all()}
        return [
            n for n in _collect_stakeholders(topic, metas)
            if len(n.strip()) >= 2 and n.lower() not in saved and not extraction.is_placeholder_attendee(n)
        ][:50]

    @action(detail=True, methods=["get", "post"], url_path="contacts")
    def contacts(self, request, pk=None):
        topic = self.get_object()
        if request.method == "GET":
            return Response(
                {
                    "contacts": ContactSerializer(topic.contacts.all(), many=True).data,
                    # Names seen as attendees that are not saved yet. Nothing is
                    # created from them until someone saves one or calls seed.
                    "suggestions": self._attendee_suggestions(topic),
                }
            )
        serializer = ContactSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        name = serializer.validated_data["name"].strip()
        if not name:
            return Response({"error": "name is required"}, status=400)
        if topic.contacts.filter(name__iexact=name).exists():
            return Response({"error": "A contact with that name already exists."}, status=400)
        contact = serializer.save(topic=topic, name=name)
        return Response(ContactSerializer(contact).data, status=201)

    @action(detail=True, methods=["post"], url_path="contacts/seed")
    def contacts_seed(self, request, pk=None):
        """Explicit "add the attendees as contacts" - only when a person asks."""
        topic = self.get_object()
        created = [Contact.objects.create(topic=topic, name=n[:150]) for n in self._attendee_suggestions(topic)]
        return Response(
            {"created": len(created), "contacts": ContactSerializer(topic.contacts.all(), many=True).data},
            status=201,
        )

    @action(detail=True, methods=["patch", "delete"], url_path=r"contacts/(?P<contact_id>\d+)")
    def contact_detail(self, request, pk=None, contact_id=None):
        topic = self.get_object()
        contact = get_object_or_404(Contact, pk=contact_id, topic=topic)
        if request.method == "DELETE":
            contact.delete()
            return Response(status=204)
        serializer = ContactSerializer(contact, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        new_name = (serializer.validated_data.get("name") or contact.name).strip()
        if topic.contacts.filter(name__iexact=new_name).exclude(pk=contact.pk).exists():
            return Response({"error": "A contact with that name already exists."}, status=400)
        serializer.save(name=new_name)
        return Response(ContactSerializer(contact).data)

    @action(detail=True, methods=["post"])
    def compute_payroll(self, request, pk=None):
        """Consolidate every ExtractedMeta.employee_hours entry across this
        topic's files into one ready-to-approve view - the "she should not go
        on to everyday data and calculate that" ask: a fresh Workflow row per
        call, never an update-in-place, so each computation is its own
        pending approval."""
        topic = self.get_object()
        month_str = timezone.now().strftime("%Y-%m")

        employees = {}
        for f in topic.files.all():
            meta = getattr(f, "meta", None)
            if not meta:
                continue
            for entry in meta.employee_hours:
                entry_date = entry.get("date")
                date_unknown = entry_date is None
                # Undated entries can't be ruled out of the current batch, so
                # they're included too (flagged) rather than silently dropped.
                if entry_date is not None and not entry_date.startswith(month_str):
                    continue
                bucket = employees.setdefault(
                    entry["name"], {"name": entry["name"], "total_hours": 0.0, "entries": []}
                )
                bucket["total_hours"] += entry["hours"]
                bucket["entries"].append(
                    {
                        "hours": entry["hours"],
                        "date": entry_date,
                        "date_unknown": date_unknown,
                        "source_file": f.display_name or f.path,
                    }
                )

        computed_data = {"month": month_str, "employees": list(employees.values())}
        workflow = Workflow.objects.create(
            topic=topic, workflow_type="payroll_approval", status="pending", computed_data=computed_data
        )
        return Response({"id": workflow.id, "computed_data": workflow.computed_data, "created_at": workflow.created_at})

    @action(
        detail=True,
        methods=["post"],
        url_path=r"workflows/(?P<workflow_id>[^/.]+)/approve",
    )
    def approve_payroll(self, request, pk=None, workflow_id=None):
        topic = self.get_object()
        workflow = get_object_or_404(Workflow, id=workflow_id, topic=topic)
        workflow.status = "approved"
        workflow.approved_at = timezone.now()
        workflow.save()
        return Response(WorkflowSerializer(workflow).data)


class TaskViewSet(viewsets.ModelViewSet):
    """Kanban-board tasks / Commitments - see models.Task. Most rows are
    created automatically by _extract_and_store from a meeting's action
    items (source_file set); a person can also add one manually from the
    Context Node's Commitments card (source_file left null) - that's the
    only signal distinguishing "AI-extracted" from "manually added", so no
    extra field was needed for it. title/assignee/status/topic are writable;
    source_file/created_at/updated_at stay read-only, and due_date is not
    exposed at all (8 Oct 2026 - see TaskSerializer)."""

    serializer_class = TaskSerializer

    def get_queryset(self):
        qs = Task.objects.select_related("topic", "source_file", "source_file__meta")
        topic_id = self.request.query_params.get("topic")
        if topic_id:
            qs = qs.filter(topic_id=topic_id)
        return qs

    @action(detail=True, methods=["get"], url_path="source")
    def source(self, request, pk=None):
        """Where this action item came from - the file (shown by its template
        name, with its real file name second) and the passage of it that best
        matches the task. Computed on demand, when someone clicks the item, so
        the task list itself stays light. A task a person added by hand has no
        source file and says so. The passage is the closest match found in the
        file's own text, not a stored quote (the LLM rewrote the wording into
        a short task), so it is labelled as such and left out when nothing
        matches well enough."""
        task = self.get_object()
        f = task.source_file
        if f is None:
            return Response({"added_by_hand": True, "file": None, "passage": None})
        meta = getattr(f, "meta", None)
        meeting_date = meta.meeting_date if meta else None
        return Response(
            {
                "added_by_hand": False,
                "file": {
                    "id": f.id,
                    "name": doc_meta.primary_filename(f) or f.display_name or "",
                    "label": doc_meta.display_title(f),
                    "doc_type": f.doc_type,
                    "read_by_ai": f.doc_type_source == "llm",
                    "meeting_title": (meta.meeting_title if meta else "") or "",
                    "date": (meeting_date or f.document_date or f.first_added_at.date()).isoformat(),
                    "openable": not f.path.startswith(("pasted:", "mbox:", "ics:")),
                },
                "passage": evidence.find_supporting_passage(f.extracted_text, task.title),
            }
        )

    @action(detail=True, methods=["post"], url_path="ai_execute")
    def ai_execute(self, request, pk=None):
        """The Action Center's 'AI Execute' - a ready-to-edit draft for this
        one task (a status email, an agenda line, whatever its own wording
        calls for). Never sent anywhere itself - just returned for the
        person to review, edit, and copy, matching the PRD's own "no email
        sending / no external writes" non-goal."""
        task = self.get_object()
        draft, is_llm, note = llm_brief.generate_task_draft(task, _current_llm_settings())
        return Response({"draft": draft, "is_llm": is_llm, "note": note})


class DecisionViewSet(viewsets.ModelViewSet):
    """Structured, persistent decision records - see models.Decision. Same
    shape/conventions as TaskViewSet: filterable by ?topic=, all fields
    writable except source_file/created_at."""

    serializer_class = DecisionSerializer

    def get_queryset(self):
        qs = Decision.objects.select_related("topic", "source_file")
        topic_id = self.request.query_params.get("topic")
        if topic_id:
            qs = qs.filter(topic_id=topic_id)
        return qs


class CommitmentViewSet(viewsets.ModelViewSet):
    """A person's promise/obligation - see models.Commitment. Deliberately
    separate from Task (which lives in TaskViewSet/the Work tab's Kanban
    board); a Commitment may optionally point at a Task via linked_task, but
    the two are independent records. Same ?topic= filter pattern as every
    other per-topic viewset in this file."""

    serializer_class = CommitmentSerializer

    def get_queryset(self):
        qs = Commitment.objects.select_related("topic", "source_file", "linked_task")
        topic_id = self.request.query_params.get("topic")
        if topic_id:
            qs = qs.filter(topic_id=topic_id)
        return qs


class RiskViewSet(viewsets.ModelViewSet):
    """Structured, tracked risks/blockers - see models.Risk. Same shape/
    conventions as DecisionViewSet: filterable by ?topic=, all fields
    writable except source_file/created_at."""

    serializer_class = RiskSerializer

    def get_queryset(self):
        qs = Risk.objects.select_related("topic", "source_file")
        topic_id = self.request.query_params.get("topic")
        if topic_id:
            qs = qs.filter(topic_id=topic_id)
        return qs


class CalendarView(APIView):
    """Across ALL topics, every ExtractedMeta row with a real meeting_date -
    optionally filtered to one topic via ?topic_id=<id>. A date-sorted list so
    a calendar widget can highlight a day with a meeting, tagged by "kind"
    (action items no longer have a due date, so they are not on the calendar).
    Deliberately not nested under the topics router since it spans topics."""

    def get(self, request):
        topic_id = request.query_params.get("topic_id")

        meta_qs = ExtractedMeta.objects.filter(meeting_date__isnull=False).select_related(
            "ingested_file", "ingested_file__topic"
        )
        if topic_id:
            meta_qs = meta_qs.filter(ingested_file__topic_id=topic_id)

        data = []
        for m in meta_qs:
            topic = m.ingested_file.topic
            data.append(
                {
                    "kind": "meeting",
                    "date": m.meeting_date.isoformat(),
                    "topic_id": topic.id,
                    "topic_name": topic.name,
                    "topic_type": topic.topic_type,
                    "id": m.id,
                    "file_display_name": m.ingested_file.display_name,
                    "file_path": m.ingested_file.path,
                    "meeting_title": m.meeting_title,
                    "meeting_date": m.meeting_date.isoformat(),
                    "meeting_time": m.meeting_time,
                    "attendees": extraction.clean_attendees(m.attendees),
                    "agenda": m.agenda,
                    "achieved": m.achieved,
                    "meeting_type": m.meeting_type,
                    "meeting_sequence": m.meeting_sequence,
                }
            )

        # Action items no longer carry a due date (Ayush, 8 Oct 2026), so they
        # no longer put dates on the calendar - it shows meetings only.

        data.sort(key=lambda e: e["date"], reverse=True)
        return Response(data)


class GlobalSourcesView(APIView):
    """Every ingested file across every project, one browsable library - the
    ingestion pipeline (folder scan / upload / paste / mailbox / ICS) is the
    thing OrientMe actually runs on, so it earns its own cross-project view
    instead of only being reachable one project's "Manage sources" modal at
    a time (17 Sep sprint: Venki's own emphasis on the ingestion mechanism
    being central to how the product works). Optionally filtered to one
    topic via ?topic_id=<id>. Deliberately not nested under the topics
    router since it spans topics, same reasoning as CalendarView above."""

    def get(self, request):
        topic_id = request.query_params.get("topic_id")
        qs = IngestedFile.objects.select_related("topic", "meta").order_by("-first_added_at")
        if topic_id:
            qs = qs.filter(topic_id=topic_id)

        data = [
            {
                "id": f.id,
                "topic_id": f.topic.id,
                "topic_name": f.topic.name,
                "topic_type": f.topic.topic_type,
                "path": f.path,
                "display_name": f.display_name,
                "source_method": f.source_method,
                "artifact_type": artifact_type_for(f),
                "first_added_at": f.first_added_at.isoformat(),
                **file_metadata_payload(f),
            }
            for f in qs
        ]
        return Response(data)


class GlobalTimelineView(APIView):
    """A cross-project activity feed - meetings ingested, status updates
    (fresh AI briefs), and tasks added/completed, across every project,
    newest first. The per-project Timeline tab already answers "what's
    happened on THIS project"; this answers "what's happened anywhere I'm
    tracking" - a genuinely different, non-redundant question, and the one
    Venki himself called out as needing real logic ("the project timeline
    is being constructed from... meeting transcripts... the logic of this
    is going to be important"). Capped at 200 most recent entries - this is
    a pulse, not a full audit log. Optionally filtered to one topic via
    ?topic_id=<id>."""

    def get(self, request):
        topic_id = request.query_params.get("topic_id")
        events = []

        meta_qs = ExtractedMeta.objects.filter(meeting_date__isnull=False).select_related(
            "ingested_file", "ingested_file__topic"
        )
        if topic_id:
            meta_qs = meta_qs.filter(ingested_file__topic_id=topic_id)
        for m in meta_qs:
            topic = m.ingested_file.topic
            events.append(
                {
                    "kind": "meeting",
                    "date": m.meeting_date.isoformat(),
                    "topic_id": topic.id,
                    "topic_name": topic.name,
                    "title": (
                        _meeting_display_title(m) if m.meeting_type else (m.meeting_title or m.ingested_file.display_name)
                    ),
                }
            )

        # Business events (5 Oct 2026): emails, key documents and human notes.
        file_qs = IngestedFile.objects.filter(
            doc_type__in=("email",) + _TIMELINE_DOC_TYPES
        ).exclude(meta_state="error").select_related("topic")
        note_qs = MeetingNote.objects.select_related("topic")
        if topic_id:
            file_qs = file_qs.filter(topic_id=topic_id)
            note_qs = note_qs.filter(topic_id=topic_id)
        for f in file_qs:
            when = f.document_date or f.first_added_at.date()
            if f.doc_type == "email":
                kind = "email"
                title = doc_meta.email_subject(f.extracted_text) or f.display_name or "Email"
            else:
                kind = "document"
                title = f"{doc_meta.DOC_TYPE_LABELS.get(f.doc_type, 'Document')} {f.version_label}".strip()
            events.append(
                {
                    "kind": kind,
                    "date": when.isoformat(),
                    "topic_id": f.topic_id,
                    "topic_name": f.topic.name,
                    "title": title,
                }
            )
        for n in note_qs:
            events.append(
                {
                    "kind": "note",
                    "date": n.created_at.date().isoformat(),
                    "topic_id": n.topic_id,
                    "topic_name": n.topic.name,
                    "title": "Note: " + _truncate(" ".join(n.text.split()), 100),
                }
            )

        task_qs = Task.objects.select_related("topic")
        if topic_id:
            task_qs = task_qs.filter(topic_id=topic_id)
        for t in task_qs:
            events.append(
                {
                    "kind": "task",
                    "date": t.created_at.date().isoformat(),
                    "topic_id": t.topic.id,
                    "topic_name": t.topic.name,
                    "title": f"Task added: {t.title}",
                }
            )
            if t.status == "done":
                events.append(
                    {
                        "kind": "task-done",
                        "date": t.updated_at.date().isoformat(),
                        "topic_id": t.topic.id,
                        "topic_name": t.topic.name,
                        "title": f"Task completed: {t.title}",
                    }
                )

        summary_qs = CaseSummary.objects.select_related("topic")
        if topic_id:
            summary_qs = summary_qs.filter(topic_id=topic_id)
        for s in summary_qs:
            events.append(
                {
                    "kind": "status",
                    "date": s.generated_at.date().isoformat(),
                    "topic_id": s.topic.id,
                    "topic_name": s.topic.name,
                    "title": (s.answer_summary or s.current_state or "Brief regenerated").strip()[:140],
                }
            )

        events.sort(key=lambda e: e["date"], reverse=True)
        return Response(events[:200])


def _search_snippet(text, tokens, context=70):
    """The excerpt shown for a content-matched ("Topic") search result - the
    plain text around wherever the first token actually appears, so someone
    can see WHY it matched without opening the file. No LLM summarizing or
    guessing a page/paragraph number here - just the real surrounding
    characters, collapsed to one line. Returns "" if none of the tokens are
    actually found (shouldn't happen given the caller already filtered on
    this, but keeps this function safe to call standalone)."""
    lower = text.lower()
    pos = -1
    for tok in tokens:
        pos = lower.find(tok)
        if pos != -1:
            break
    if pos == -1:
        return ""
    start = max(0, pos - context)
    end = min(len(text), pos + context)
    snippet = " ".join(text[start:end].split())  # collapse newlines/whitespace to one line
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    return snippet


class GlobalSearchView(APIView):
    """The universal search (Ctrl/Cmd+K) - one query fanned out across
    Projects, People, Topics (content matches), Files (name matches), and
    Tasks, each capped to a handful of results. Server-side so the frontend
    never has to ship every project's full data down just to filter it
    client-side.

    Shape follows the "Website Search Journey" design Ayush shared (30
    Sep): type a few words -> grouped suggestions -> pick a Project/Person/
    Topic/File result -> land on a destination that shows provenance
    ("N source items", "Last indexed: <date>") and freshness. Concretely:
      - "projects": name/one_liner/related_people matches; each carries
        file_count + last_indexed so the palette can show "12 files ·
        updated 2 days ago" per the wireframe's "Evidence links" line.
      - "stakeholders" ("Person" in the design): grouped by person, one
        entry per name with the list of projects they appear in - "Projects
        worked with <name>", not a standalone profile page, matching the
        design's own behavior contract ("Person opens related projects,
        not a profile").
      - "topics" ("Topic" in the design): CONTENT matches inside a file's
        extracted text, each with a real excerpt of the matched passage
        (see _search_snippet) plus last_indexed - the "cited matches" the
        wireframe shows (e.g. "Kickoff notes.pdf | ...matched text...").
        Deliberately shows a text excerpt, not a fabricated page/timestamp
        number this app has no reliable way to compute for arbitrary files.
      - "files" ("File" in the design): FILENAME matches - a file can
        appear in both "files" (name matched) and "topics" (content
        matched); that's two true, independent statements about the same
        file, not a duplicate bug.
      - "tasks": kept as a 5th, additional category beyond the design's
        four - dropping working task search wasn't asked for, and the
        wireframe's own suggestion list is captioned "vary by query", not a
        closed set.
    "Permissions filter results before they appear" (the design's own
    behavior contract): this app has no per-project ACL - every logged-in
    user already sees every project (a single shared internal tool, not
    multi-tenant) - so the one real permission gate is DRF's own
    IsAuthenticated default on this view; there is no finer-grained
    filtering to add without a real per-project ownership model that
    doesn't exist yet.

    Rewritten 30 Sep (Ayush, real bug report + explicit spec): tokenizing
    the query and requiring every token to appear somewhere (any order, any
    field) so multi-word queries match regardless of word order or which
    field carries which word. Deliberately still no LLM anywhere in here -
    every match is a plain, fast substring check per token, same "less LLM,
    more code" rule as the rest of this app.

    Deliberately does NOT reach into not-yet-routed RecordingEvents
    (needs_review/pending_new_project) - Ayush's own correction, same day:
    "remove the overall search thing in the transcript screen because both
    are different". Triaging a brand-new, untagged recording is a
    different activity from finding something you already know exists;
    those stay exclusively on the Transcripts page's own list + quick-tag
    flow, not blended into this general-purpose search."""

    def get(self, request):
        empty = {"projects": [], "stakeholders": [], "topics": [], "files": [], "tasks": []}
        q = (request.query_params.get("q") or "").strip()
        tokens = [t for t in q.lower().split() if t]
        if not tokens:
            return Response(empty)

        def all_tokens_q(*field_names):
            """AND across tokens, OR across the given fields per token - so
            a multi-word query matches regardless of which field carries
            which word, and regardless of the words' order."""
            combined = Q()
            for i, tok in enumerate(tokens):
                tok_q = Q()
                for field in field_names:
                    tok_q |= Q(**{f"{field}__icontains": tok})
                combined = tok_q if i == 0 else combined & tok_q
            return combined

        project_qs = Topic.objects.filter(
            all_tokens_q("name", "one_liner", "related_people")
        ).prefetch_related("files")[:8]

        # Attendee names live inside ExtractedMeta.attendees, a JSON list -
        # SQLite has no clean "does this list contain a substring" query via
        # the ORM, so this filters in Python. Bounded to a few hundred rows
        # (one per ingested file that looked like a meeting, not per byte of
        # file content), which is fine at this app's real scale.
        people = {}  # lower(name) -> {"name": real-cased name, "projects": [...]}
        metas = ExtractedMeta.objects.exclude(attendees=[]).select_related(
            "ingested_file__topic"
        )[:300]
        for m in metas:
            for name in extraction.clean_attendees(m.attendees):
                lname = name.lower()
                if not all(tok in lname for tok in tokens):
                    continue
                entry = people.setdefault(lname, {"name": name, "projects": [], "_seen_topics": set()})
                topic_id = m.ingested_file.topic_id
                if topic_id in entry["_seen_topics"]:
                    continue
                entry["_seen_topics"].add(topic_id)
                entry["projects"].append(
                    {"topic_id": topic_id, "topic_name": m.ingested_file.topic.name}
                )
            if len(people) >= 8:
                break
        for entry in people.values():
            del entry["_seen_topics"]

        tasks = Task.objects.filter(all_tokens_q("title")).select_related("topic")[:8]

        # Files - filename match only ("File" in the design). Content
        # matches are a separate query below ("Topic" in the design), even
        # though both read from the same IngestedFile table.
        name_files = IngestedFile.objects.filter(
            all_tokens_q("display_name")
        ).select_related("topic")[:8]

        content_files = IngestedFile.objects.filter(
            all_tokens_q("extracted_text")
        ).select_related("topic")[:8]

        return Response(
            {
                "projects": [
                    {
                        "id": t.id,
                        "name": t.name,
                        "one_liner": t.one_liner,
                        "topic_type": t.topic_type,
                        "file_count": len(t.files.all()),
                        "last_indexed": (
                            max((f.last_ingested_at for f in t.files.all()), default=None).isoformat()
                            if t.files.all()
                            else None
                        ),
                    }
                    for t in project_qs
                ],
                "stakeholders": list(people.values())[:8],
                "tasks": [
                    {"id": t.id, "title": t.title, "topic_id": t.topic_id, "topic_name": t.topic.name}
                    for t in tasks
                ],
                "files": [
                    {
                        "id": f.id,
                        "display_name": f.display_name or f.path,
                        "topic_id": f.topic_id,
                        "topic_name": f.topic.name,
                        "last_indexed": f.last_ingested_at.isoformat(),
                    }
                    for f in name_files
                ],
                "topics": [
                    {
                        "id": f.id,
                        "display_name": f.display_name or f.path,
                        "topic_id": f.topic_id,
                        "topic_name": f.topic.name,
                        "snippet": _search_snippet(f.extracted_text, tokens),
                        "last_indexed": f.last_ingested_at.isoformat(),
                    }
                    for f in content_files
                ],
            }
        )


class SearchLogView(APIView):
    """POST-only: records one search outcome (see models.SearchLog) so
    Venki/Ayush can browse real search queries and their outcomes later in
    Django admin and improve the matching logic from real usage instead of
    guessing. A logging failure must never break search itself - this
    view's only job is to persist a row, so any bad/missing field is
    coerced to a safe default rather than raising."""

    def post(self, request):
        topic_id = request.data.get("topic_id") or None
        SearchLog.objects.create(
            query=(request.data.get("query") or "")[:300],
            result_count=int(request.data.get("result_count") or 0),
            chosen_kind=request.data.get("chosen_kind") or "none",
            chosen_label=(request.data.get("chosen_label") or "")[:300],
            topic_id=topic_id,
            user=request.user if request.user.is_authenticated else None,
        )
        return Response({"ok": True})


class StatsView(APIView):
    """Company-wide counts for the Statistics page - plain aggregate numbers
    genuinely computable from what's already stored, no invented metrics."""

    def get(self, request):
        return Response(
            {
                "topics": Topic.objects.count(),
                "files": IngestedFile.objects.count(),
                "meetings": ExtractedMeta.objects.count(),
                "tasks_backlog": Task.objects.filter(status="backlog").count(),
                "tasks_in_progress": Task.objects.filter(status="in_progress").count(),
                "tasks_done": Task.objects.filter(status="done").count(),
            }
        )


class SettingsView(APIView):
    KEYS = [
        "llm_provider", "llm_api_key", "llm_model", "llm_base_url", "default_directory", "stale_after_days",
        "recordings_watch_folder", "recordings_suggest_new_topics", "transcription_engine",
        "external_transcription_url", "manual_drop_folder",
    ]

    def get(self, request):
        data = _current_llm_settings()
        # Never echo the real key back in full - same masking convention as
        # the other in-house tools' Settings pages.
        if data["llm_api_key"]:
            data["llm_api_key_set"] = True
            data["llm_api_key"] = ""
        else:
            data["llm_api_key_set"] = False
        return Response(data)

    def post(self, request):
        denied = _require_settings_password(request)
        if denied:
            return denied
        for k in self.KEYS:
            if k not in request.data:
                continue
            value = request.data[k]
            # llm_api_key is masked: GET never echoes the real value, and the
            # UI's "leave blank to keep" placeholder relies on a blank submit
            # NOT overwriting the stored key. Every other key has no masking
            # (GET round-trips it as-is), so an explicit empty string there is
            # a deliberate clear - e.g. default_directory - and must be saved,
            # not silently dropped.
            if k == "llm_api_key" and value == "":
                continue
            Settings.set(k, value)
        return Response({"saved": True})


class SettingsUnlockView(APIView):
    """Checks the settings password without saving anything, so the Settings
    page can unlock its fields only after the right password is typed. The
    unlock itself lives only in the page (nothing is remembered on the server):
    every save re-sends the password and SettingsView.post checks it again."""

    def post(self, request):
        denied = _require_settings_password(request)
        if denied:
            return denied
        return Response({"ok": True})


class LoopViewSet(viewsets.ModelViewSet):
    """Saved 'Ask OrientMe' prompts (see models.Loop) - list/create/delete a
    saved question, and manually re-run one through the exact same global-
    ask pipeline every other question goes through. No PUT/PATCH - a saved
    prompt's text isn't meant to be edited in place, just re-asked or
    removed and re-saved."""

    queryset = Loop.objects.all()
    serializer_class = LoopSerializer
    http_method_names = ["get", "post", "delete", "head", "options"]

    @action(detail=True, methods=["post"])
    def run(self, request, pk=None):
        loop = self.get_object()
        result = _ask_global(loop.question)
        Loop.objects.filter(id=loop.id).update(last_run_at=timezone.now(), run_count=F("run_count") + 1)
        return Response(result)


class RecordingEventViewSet(viewsets.ReadOnlyModelViewSet):
    """The Transcripts page's activity feed - every file the central
    Recordings-folder watcher (core/recordings.py) has ever found, whatever
    it did with it. Read-only except for assign_topic, the one write action
    a person actually needs: manually routing a 'needs_review' recording
    once the automatic match/auto-create pipeline couldn't confidently
    decide on its own."""

    queryset = RecordingEvent.objects.select_related("topic", "ingested_file").all()
    serializer_class = RecordingEventSerializer

    def get_serializer_context(self):
        context = super().get_serializer_context()
        if self.action == "list":
            context["omit_speaker_turns"] = True
        return context

    def retrieve(self, request, *args, **kwargs):
        """Detail page: if the transcript has text but no speaker turns yet, prepare
        them once - inline for Teams-format text (no LLM), in the background
        through the API model for Whisper text when a key is configured. The
        response says speaker_turns_generating=true while that runs."""
        event = self.get_object()
        recordings.ensure_speaker_turns(event, background=True)
        event.refresh_from_db()
        return Response(self.get_serializer(event).data)

    @action(detail=True, methods=["post"], url_path="rename_speaker")
    def rename_speaker(self, request, pk=None):
        """Renames one speaker label across all turns of this event, e.g.
        {"old": "Speaker 1", "new": "Gokul"}; renamed turns are marked edited."""
        event = self.get_object()
        old = str(request.data.get("old") or "").strip()
        new = " ".join(str(request.data.get("new") or "").split())
        if not old or not new:
            return Response({"error": "old and new are required"}, status=400)
        if len(new) > 60:
            return Response({"error": "A speaker name can be at most 60 characters."}, status=400)
        changed = recordings.rename_speaker(event, old, new)
        if not changed:
            return Response({"error": f"No turns are labelled '{old}'."}, status=404)
        event.refresh_from_db()
        return Response({**RecordingEventSerializer(event).data, "renamed_turns": changed})

    @action(detail=False, methods=["post"], parser_classes=[MultiPartParser])
    def upload(self, request):
        """The dashboard/Transcripts page's real drag-and-drop upload widget
        - Venki's original ask, 30 Sep meeting: "I drag and drop a bunch of
        files into the web interface... give me a multi-file interface."
        The manual_drop_folder Setting only ever covered files dropped by
        hand into a watched folder; this is the actual in-browser version of
        the same idea. Saves each upload into that same configured folder
        (so it behaves identically to one dropped there by hand) or, if
        that Setting is still empty, into MEDIA_ROOT/manual_uploads/ so the
        feature works before anyone's configured a folder at all. Runs
        process_new_recording() synchronously per file - same cost the
        folder-watcher already pays for transcription - so the response
        carries each file's resulting RecordingEvent immediately."""
        files = request.FILES.getlist("files")
        if not files:
            return Response({"error": "files is required"}, status=400)

        # A project is REQUIRED at upload time - there is no holding area.
        raw_topic_id = (request.data.get("topic_id") or "").strip() if isinstance(
            request.data.get("topic_id"), str
        ) else request.data.get("topic_id")
        if not raw_topic_id:
            return Response(
                {"error": "Choose a project for these files first - every upload must go into a project."},
                status=400,
            )
        try:
            target_topic = Topic.objects.filter(pk=int(raw_topic_id)).first()
        except (TypeError, ValueError):
            target_topic = None
        if target_topic is None:
            return Response(
                {"error": "That project doesn't exist - choose an existing project for these files."},
                status=400,
            )

        # A real, hard cap - not arbitrary caution: dropping a whole folder
        # was tried for real (Ayush, 30 Sep) and produced "Failed to fetch"
        # - one giant multipart request holding many files open, each
        # transcribed/extracted synchronously one at a time, comfortably
        # outran the browser's own request timeout with no response ever
        # sent back, which is indistinguishable from a network failure on
        # the client. A clear 400 for "too many at once" beats a silent,
        # unexplained connection drop.
        MAX_FILES_PER_UPLOAD = 25
        if len(files) > MAX_FILES_PER_UPLOAD:
            return Response(
                {
                    "error": f"That's {len(files)} files at once - please drop {MAX_FILES_PER_UPLOAD} or "
                    "fewer at a time (each one is transcribed/read synchronously, so a very large batch "
                    "can time out before any of them finish)."
                },
                status=400,
            )

        target_dir = Settings.get("manual_drop_folder", "").strip()
        if not target_dir:
            target_dir = os.path.join(django_settings.MEDIA_ROOT, "manual_uploads")
        os.makedirs(target_dir, exist_ok=True)

        results = []
        touched_topic_ids = set()
        for upload in files:
            # Folder drops can include directory-entry placeholders and
            # zero-byte junk (.DS_Store, desktop.ini, a bare folder name
            # with no extension) depending on the browser's own drag-and-drop
            # implementation - skip anything that isn't a real file with
            # content rather than let it corrupt the batch.
            if not upload.name or upload.size == 0:
                continue
            # A file type nothing here can even attempt to read (code,
            # images, configs, .zip, etc. swept up in a real folder drop -
            # Ayush's own correction, 30 Sep, after a whole project folder
            # produced ~300 permanent "Couldn't read this file" rows: "dont
            # add unreadable file make the system like that"). Never saved,
            # never given a RecordingEvent row at all - just reported back
            # in this response so the person doing THIS upload still knows
            # it was skipped, without it becoming a standing Dashboard item
            # anyone has to go dismiss.
            upload_ext = os.path.splitext(upload.name)[1].lower()
            if upload_ext not in ingestion.SUPPORTED_EXTENSIONS:
                results.append(
                    {
                        "file_path": upload.name,
                        "file_name": os.path.basename(upload.name),
                        "skipped": True,
                        "reason": f"Unsupported file type ({upload_ext or 'no extension'}) - not added.",
                    }
                )
                continue
            try:
                safe_name = os.path.basename(upload.name.replace("\\", "_").replace("/", "_"))
                dest_path = os.path.join(target_dir, safe_name)
                # Never clobber an existing file with the same name.
                stem, ext = os.path.splitext(dest_path)
                n = 1
                while os.path.exists(dest_path):
                    dest_path = f"{stem} ({n}){ext}"
                    n += 1
                with open(dest_path, "wb") as f:
                    for chunk in upload.chunks():
                        f.write(chunk)
                # A plain document (proposal, quotation, email, spreadsheet...) is
                # filed under its own name - not turned into a "<name> -
                # Transcript.txt" copy and a Transcripts-page recording. Only
                # audio/video and transcript-shaped text take the recording path.
                if not recordings.is_recording_or_transcript(dest_path):
                    doc, doc_error = recordings.ingest_document(
                        target_topic, dest_path, display_name=safe_name
                    )
                    touched_topic_ids.add(target_topic.id)
                    results.append(
                        {
                            "id": None,
                            "document": True,
                            "file_path": dest_path,
                            "file_name": safe_name,
                            "topic": target_topic.id,
                            "topic_name": target_topic.name,
                            "ingested_file": doc.id,
                            "status": "routed",
                            "detail": f"Added to '{target_topic.name}' as a document (not a recording).",
                            "error": doc_error,
                        }
                    )
                    continue
                # refresh_brief=False here on purpose - see _ingest_into_topic's
                # own docstring. One LLM brief call per file in a big batch is
                # exactly what caused the real "Failed to fetch" bug; every
                # topic that actually received a file gets exactly one
                # refresh below, after the whole batch is done.
                recordings.process_new_recording(
                    dest_path, source="manual_drop", allow_llm_routing=False, refresh_brief=False,
                    target_topic=target_topic,
                )
                event = RecordingEvent.objects.filter(file_path=dest_path).first()
                if event and event.topic_id:
                    touched_topic_ids.add(event.topic_id)
                results.append(
                    RecordingEventSerializer(event).data
                    if event
                    else {"file_path": dest_path, "error": "Processing failed."}
                )
            except Exception as exc:  # noqa: BLE001 - one bad file must never sink the whole batch
                logger.exception("Upload: failed to save/process %s", upload.name)
                results.append({"file_path": upload.name, "error": str(exc)[:300]})

        if touched_topic_ids:
            for topic in Topic.objects.filter(id__in=touched_topic_ids):
                try:
                    _ask_topic(topic, CONTEXT_BRIEF_QUESTION)
                except Exception:  # noqa: BLE001 - the upload itself already succeeded either way
                    logger.exception("Upload: brief refresh failed for topic %s", topic.id)

        return Response({"results": results})

    @action(detail=True, methods=["post"])
    def dismiss(self, request, pk=None):
        """The corner "x" on a pending transcript card - Ayush's own ask,
        30 Sep: "add a cross option in the corner to not assign and remove
        this card". Never a hard delete - keeps the row (status='dismissed')
        so the Transcripts/Dashboard "needs review" lists stop showing it
        permanently, without silently losing the record of what happened to
        this file, matching this pipeline's own "every file gets exactly one
        RecordingEvent row, honest about the outcome" rule."""
        event = self.get_object()
        event.status = "dismissed"
        event.detail = "Dismissed - not tracked."
        event.pending_extracted_text = ""
        event.save()
        return Response(RecordingEventSerializer(event).data)

    @action(detail=False, methods=["post"], url_path="bulk_dismiss")
    def bulk_dismiss(self, request):
        """Same dismiss as above, applied to many rows in one request -
        Ayush's own real complaint, 30 Sep, after a whole project folder of
        source files landed as ~50 individual 'Couldn't read this file'
        cards: "everytime i have to click cross cross... make it simple
        like multi select". One clean UPDATE rather than N round-trips."""
        event_ids = request.data.get("event_ids") or []
        if not event_ids:
            return Response({"error": "event_ids is required"}, status=400)
        updated = RecordingEvent.objects.filter(id__in=event_ids).update(
            status="dismissed", detail="Dismissed - not tracked.", pending_extracted_text=""
        )
        return Response({"dismissed_count": updated})

    @action(detail=True, methods=["post"])
    def assign_topic(self, request, pk=None):
        event = self.get_object()
        topic = get_object_or_404(Topic, pk=request.data.get("topic_id"))
        if event.ingested_file:
            # Already real, ingested content - just repoint the existing
            # row to the new topic. Re-running _ingest_into_topic here would
            # write a SECOND transcript file + a second IngestedFile row,
            # leaving the original behind as an orphaned duplicate.
            obj = event.ingested_file
            if obj.topic_id != topic.id:
                obj.topic = topic
                obj.save(update_fields=["topic"])
                _ask_topic(topic, CONTEXT_BRIEF_QUESTION)
        else:
            # Never ingested before (an older-style needs_review event with
            # no IngestedFile yet) - first real ingest.
            text = event.pending_extracted_text
            if not text:
                try:
                    text = ingestion.extract_text(event.file_path)
                except Exception as exc:  # noqa: BLE001 - report it, don't 500
                    return Response({"error": f"Could not read this recording: {exc}"}, status=400)
            obj = recordings._ingest_into_topic(topic, event.file_path, text)
        event.topic = topic
        event.ingested_file = obj
        event.status = "routed"
        event.detail = "Manually assigned."
        event.pending_extracted_text = ""
        event.save()
        return Response(RecordingEventSerializer(event).data)

    @action(detail=True, methods=["post"], url_path="confirm_new_project")
    def confirm_new_project(self, request, pk=None):
        """The approve half of the human-in-the-loop gate on new-project
        creation - a person may edit the suggested name/one-liner/type
        before it becomes real, so the request body's fields (all optional)
        override the LLM's own suggestion rather than replace it blindly."""
        event = self.get_object()
        if event.status != "pending_new_project":
            return Response({"error": "This recording has no pending new-project suggestion."}, status=400)
        name = (request.data.get("name") or "").strip() or None
        one_liner = request.data.get("one_liner")
        if one_liner is not None:
            one_liner = one_liner.strip()
        topic_type = (request.data.get("topic_type") or "").strip() or None
        try:
            event = recordings.confirm_new_project(event, name=name, one_liner=one_liner, topic_type=topic_type)
        except Exception as exc:  # noqa: BLE001 - report it, don't 500
            return Response({"error": f"Could not create the project: {exc}"}, status=400)
        return Response(RecordingEventSerializer(event).data)

    @action(detail=True, methods=["post"], url_path="reject_new_project")
    def reject_new_project(self, request, pk=None):
        event = self.get_object()
        if event.status != "pending_new_project":
            return Response({"error": "This recording has no pending new-project suggestion."}, status=400)
        event = recordings.reject_new_project(event)
        return Response(RecordingEventSerializer(event).data)

    @action(detail=True, methods=["post"], url_path="create_project")
    def create_project(self, request, pk=None):
        """The manual counterpart to confirm_new_project - a person deciding
        ON THEIR OWN that a recording deserves its own project, rather than
        only ever reacting to the LLM router's own suggestion. Works from
        ANY status (needs_review, pre_existing, even routed/error) as long
        as the recording's text is retrievable - recordings.
        confirm_new_project already falls back to re-transcribing from
        event.file_path when no text is cached yet, so a never-processed
        'pre_existing' recording works here too, on demand, without a
        separate 'process it first' step. Requires an explicit name (no
        LLM suggestion to fall back to)."""
        event = self.get_object()
        name = (request.data.get("name") or "").strip()
        if not name:
            return Response({"error": "A project name is required."}, status=400)
        one_liner = (request.data.get("one_liner") or "").strip()
        topic_type = (request.data.get("topic_type") or "").strip() or "project"
        try:
            event = recordings.confirm_new_project(event, name=name, one_liner=one_liner, topic_type=topic_type)
        except Exception as exc:  # noqa: BLE001 - report it, don't 500
            return Response({"error": f"Could not create the project: {exc}"}, status=400)
        return Response(RecordingEventSerializer(event).data)

    @action(detail=True, methods=["get"])
    def text(self, request, pk=None):
        """The transcript detail page's raw-text panel - whatever text
        currently represents this recording (see recordings.
        _current_transcript_text's own docstring for why that's two
        different fields depending on status)."""
        event = self.get_object()
        text = event.ingested_file.extracted_text if event.ingested_file else event.pending_extracted_text
        return Response({"text": text})

    @action(detail=True, methods=["post"], url_path="generate_summary")
    def generate_summary(self, request, pk=None):
        """The detail page's 'Generate Summary'/'Regenerate' button - never
        run automatically, only from this explicit click. Code-based, not
        an LLM call (see recordings.generate_summary_for_event's own
        docstring) - is_llm/message are kept in the response shape for the
        frontend's sake but are always False/None now."""
        event = self.get_object()
        event, is_llm, message = recordings.generate_summary_for_event(event)
        return Response({**RecordingEventSerializer(event).data, "is_llm": is_llm, "message": message})

    @action(detail=True, methods=["post"])
    def diarize(self, request, pk=None):
        """The detail page's 'Diarize' button - asks the local model (see
        recordings.diarize_event) to produce the structured participants/
        decisions/action-items/parked-items/per-speaker breakdown."""
        event = self.get_object()
        event, succeeded, message = recordings.diarize_event(event)
        return Response(
            {**RecordingEventSerializer(event).data, "succeeded": succeeded, "message": message}
        )

    @action(detail=True, methods=["post"], url_path="generate_transcript")
    def generate_transcript(self, request, pk=None):
        """The detail page's 'Generate Transcript' button - speaker name +
        timestamp + speech, per turn (see recordings.generate_speaker_transcript)."""
        event = self.get_object()
        event, succeeded, message = recordings.generate_speaker_transcript(event)
        return Response(
            {**RecordingEventSerializer(event).data, "succeeded": succeeded, "message": message}
        )

    @action(detail=True, methods=["post"], url_path="save_summary")
    def save_summary(self, request, pk=None):
        """The detail page's 'Save to project folder' button - only
        meaningful once this recording has a topic assigned; generating a
        summary already persists it to the database on its own."""
        event = self.get_object()
        dest_path, error = recordings.save_summary_to_project(event)
        if error:
            return Response({"error": error}, status=400)
        return Response({"saved_to": dest_path})


def _topic_brief(topic):
    """The small {id, name, topic_type, one_liner} shape OrientView returns
    for a matched or candidate topic - just enough for a frontend to show
    "here's what I found" without a second round-trip."""
    return {
        "id": topic.id,
        "name": topic.name,
        "topic_type": topic.topic_type,
        "one_liner": topic.one_liner,
    }


class OrientView(APIView):
    """The PRD's primary flow: one free-text box, not "create a Topic first".
    A person types a natural-language request; this resolves it (no LLM, no
    network - see extraction.resolve_topic) to the likely existing topic and,
    when there's a single clear match, immediately asks that same request
    text as the question against it - so typing once can land with the
    answer already there. Disambiguation only when genuinely necessary.

    AllowAny on purpose: this is the no-login search bar regular employees
    use directly (see the public /orient page) - the admin-only app (create/
    edit/ingest/settings) stays behind real login, but asking a question and
    reading the resulting brief does not. If topic_id is given, it skips
    resolve_topic entirely and asks that exact topic directly - used when a
    person picks one candidate out of an "ambiguous" result."""

    permission_classes = [AllowAny]

    def post(self, request):
        request_text = (request.data.get("request") or "").strip()
        if not request_text:
            return Response({"error": "request is required"}, status=400)

        topic_id = request.data.get("topic_id")
        if topic_id:
            topic = get_object_or_404(Topic, pk=topic_id)
            answer = _ask_topic(topic, request_text)
            return Response({"outcome": "matched", "topic": _topic_brief(topic), "answer": answer})

        result = extraction.resolve_topic(
            request_text, Topic.objects.all().prefetch_related("files__meta", "tasks")
        )

        if result["outcome"] == "matched":
            topic = result["topic"]
            answer = _ask_topic(topic, request_text)
            return Response({"outcome": "matched", "topic": _topic_brief(topic), "answer": answer})

        if result["outcome"] == "ambiguous":
            return Response(
                {
                    "outcome": "ambiguous",
                    "candidates": [_topic_brief(t) for t in result["topics"]],
                }
            )

        return Response({"outcome": "no_match", "suggested_name": result["suggested_name"]})


class ResolveOnlyView(APIView):
    """Same resolve_topic call OrientView makes, but WITHOUT the follow-up
    _ask_topic LLM call - exists so a launcher plugin (Wox) can show an
    accurate, immediate result (which topic, or which candidates, or that
    nothing matched) without ever blocking its own query() on the LLM.

    Real bug this fixes: Wox's query() previously called /orient/ directly,
    which also runs the LLM - measured at 50-70s, sometimes minutes, on the
    current free-tier model. Wox's own launcher framework has a much
    shorter patience window for a plugin to return results, so every real
    question was failing with "request timeout" - not intermittent, not
    fixable by raising the plugin's own HTTP timeout, because Wox's own
    timeout wraps the whole query() call, not just one HTTP request inside
    it. The fix: query() calls this instead (fast, deterministic, no LLM),
    and the actual slow answer only ever gets generated after Enter is
    pressed, server-side, while the browser tab is loading - never
    blocking the launcher itself. AllowAny, same public-search posture as
    OrientView."""

    permission_classes = [AllowAny]

    def post(self, request):
        request_text = (request.data.get("request") or "").strip()
        if not request_text:
            return Response({"error": "request is required"}, status=400)

        result = extraction.resolve_topic(
            request_text, Topic.objects.all().prefetch_related("files__meta", "tasks")
        )

        if result["outcome"] == "matched":
            return Response({"outcome": "matched", "topic": _topic_brief(result["topic"])})
        if result["outcome"] == "ambiguous":
            return Response(
                {"outcome": "ambiguous", "candidates": [_topic_brief(t) for t in result["topics"]]}
            )
        return Response({"outcome": "no_match", "suggested_name": result["suggested_name"]})


BRIEF_HTML_STYLE = """
body{font-family:-apple-system,'Open Sans',Segoe UI,sans-serif;background:#faf9f5;color:#2a2a28;
  max-width:1180px;margin:0 auto;padding:32px 32px 60px}
.eyebrow{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8a8578}
h1{font-size:26px;margin:4px 0 18px;color:#1a1a1a}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;
  background:#e6f6f6;color:#0a6e6e;margin-left:8px;vertical-align:middle}
.view-full-project{float:right;font-size:12.5px;font-weight:600;color:#0096af;text-decoration:none;
  border:1px solid #cdeaea;background:#f2fbfb;border-radius:6px;padding:5px 12px;vertical-align:middle}
.view-full-project:hover{background:#e6f6f6}
.card{background:#fff;border:1px solid #e8e5da;border-radius:10px;padding:24px 28px;margin-bottom:20px}
.answer{white-space:pre-wrap;line-height:1.55;font-size:14.5px}
.note{font-size:12px;color:#9a6a1a;background:#fff6e6;border:1px solid #f0dcae;border-radius:6px;
  padding:8px 12px;margin-bottom:14px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#6b6658;margin:0 0 10px}
.src{font-size:12px;color:#8a8578;margin:2px 0;display:flex;align-items:center;gap:8px}
.src-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.edit-link{flex:none;font-size:11px;font-weight:600;color:#0096af;text-decoration:none;
  border:1px solid #cdeaea;border-radius:999px;padding:1px 9px;white-space:nowrap}
.edit-link:hover{background:#e6f6f6}
.answer-summary{font-size:15.5px;line-height:1.55;color:#1a1a1a;margin:0 0 18px;padding-bottom:16px;
  border-bottom:1px solid #eee;max-width:760px}
.brief-section{margin-bottom:16px}
.brief-section h3{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:#0096af;
  margin:0 0 4px;font-weight:700}
.para{font-size:14px;line-height:1.55;color:#2a2a28;margin:0 0 4px;white-space:pre-wrap;max-width:760px}
.para-src{display:flex;flex-wrap:wrap;gap:6px;margin:0}
.para-src .edit-link{color:#8a8578;border-color:#e8e5da;font-weight:500}
.para-src .edit-link:hover{background:#f3f1ea;color:#0096af;border-color:#cdeaea}
.exec-eyebrow{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
  color:#0096af;margin:0 0 6px}

/* Three columns, per the sketch: Stakeholders + Key State (left) - the
   prompt result and its supporting detail (middle) - a NARROW Project
   Timeline (right). */
.three-col{display:flex;gap:28px;align-items:flex-start}
.three-col .col-a{flex:0 0 230px}
.three-col .col-b{flex:1;min-width:0;padding-top:2px}
.three-col .col-c{flex:0 0 300px;min-width:0}
.three-col h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b6658;
  margin:0 0 12px;font-weight:700;display:flex;align-items:center;gap:6px}
.three-col .col-a h3.key-state-h3{margin-top:22px}

.stakeholder-list{display:flex;flex-direction:column;gap:8px}
.stakeholder-row{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #ece8db;
  border-radius:10px;padding:8px 11px}
.avatar{width:30px;height:30px;border-radius:50%;flex:none;display:flex;align-items:center;
  justify-content:center;color:#fff;font-size:11.5px;font-weight:700;letter-spacing:.02em}
.stakeholder-name{font-size:13px;font-weight:600;color:#332f27}

.key-state-list{display:flex;flex-direction:column;gap:0;background:#fff;border:1px solid #ece8db;
  border-radius:10px;overflow:hidden}
.key-state-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;
  padding:8px 11px;border-bottom:1px solid #f3f1ea}
.key-state-row:last-child{border-bottom:none}
.key-state-row span:first-child{color:#57534a}
.ks-val{font-weight:700;color:#221f19}
.ks-val.ks-empty{font-weight:500;color:#b5b0a2;font-size:11px}

/* Compact timeline: a <details> accordion per row - just the date + title
   until clicked ("when i click any timeline title then it should drop
   down with the details"), no permanently-visible body text. */
.timeline{position:relative;max-height:560px;overflow-y:auto;padding-right:8px;margin-right:-8px}
.tl-item{position:relative;padding:0 0 10px 22px}
.tl-item:last-child{padding-bottom:0}
.tl-item::after{content:'';position:absolute;left:5px;top:16px;bottom:0;width:2px;background:#ece8db}
.tl-item:last-child::after{display:none}
.tl-dot{position:absolute;left:0;top:5px;width:10px;height:10px;border-radius:50%;
  border:2px solid #faf9f5;box-shadow:0 0 0 1px rgba(0,0,0,.06)}
.tl-item--meeting .tl-dot{background:#0096af}
.tl-item--status .tl-dot{background:#7c5cbf}
.tl-card{display:block}
.tl-card summary{cursor:pointer;list-style:none}
.tl-card summary::-webkit-details-marker{display:none}
.tl-card summary:hover .tl-title{color:#0096af}
.tl-date{display:block;font-size:10px;font-weight:700;color:#9a9587;margin-bottom:2px}
.tl-title{display:block;font-size:12.5px;font-weight:600;color:#221f19;line-height:1.4}
.tl-body{font-size:12px;color:#57534a;line-height:1.5;margin:6px 0 0;padding-left:1px}

/* "Relevant Topics for the Prompt" - the per-field detail, laid out as a
   responsive multi-column grid instead of one long stacked column, now
   that the page has real width to spend. */
.sections-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));
  gap:4px 28px}

@media(max-width:900px){
  body{padding:24px 18px 48px}
  .three-col{flex-direction:column;gap:24px}
  .three-col .col-a, .three-col .col-c{flex:none;width:100%}
  .sections-grid{grid-template-columns:1fr}
}
"""


# Section labels for the structured per-paragraph render - next_step is
# explicitly labeled a recommendation (matches the V0 PRD's "Recommended
# next step - labelled as a recommendation, not a fact" requirement, a real
# gap this same rendering rewrite closes alongside the source-attribution one).
_BRIEF_SECTION_LABELS = [
    ("why_now", "Why now"),
    ("current_state", "Current Position"),
    ("history", "History"),
    ("customer_thoughts", "What the customer thinks"),
    ("customer_need", "Customer need"),
    ("proposed_solution", "Proposed solution"),
    ("latest_updates", "Latest updates"),
    ("decisions_made", "Decisions made"),
    ("meeting_prep", "Meeting prep"),
    ("promises_made", "Waiting"),
    ("next_step", "Next"),
    ("risks_and_gaps", "Open questions"),
]


# Priority order for picking ONE "headline" field to label+summarize a
# timeline entry with, when the underlying CaseSummary only filled in a
# few sections (the common case now that answers are dynamic/selective -
# see llm_brief.py's prompt). Pure Python, no LLM call - deterministic
# logic derives the label from which fields are already there, same "use
# your own logic" rule this codebase follows elsewhere (extraction.py).
_TIMELINE_HEADLINE_PRIORITY = [
    ("risks_and_gaps", "Risk flagged"),
    ("next_step", "Next step update"),
    ("promises_made", "Commitment tracked"),
    ("customer_thoughts", "Customer input noted"),
    ("why_now", "Context update"),
    ("current_state", "Status update"),
    ("history", "History note"),
]


def _truncate(text, limit=110):
    text = (text or "").strip().replace("\n", " ")
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


# Python port of the frontend's toBullets (page.js) - used to count how many
# risk bullets a summary has, for the HTML brief's Key State stat.
def _count_bullets(text):
    if not text:
        return 0
    lines = [re.sub(r"^[-•]\s*", "", ln).strip() for ln in text.split("\n")]
    return len([ln for ln in lines if ln])


# Short (~3-4 word), specific timeline titles for meetings - deterministic
# pattern matching, no LLM call (same "use logic, not the LLM" rule as
# _summary_timeline_entry). Real feedback: the raw extracted meeting_title
# (often just the transcript file's own title line) is too long/verbose for
# a timeline, and case-only differences between two recordings of "the same"
# meeting ("AI Adoption Sprint Meeting" vs "AI Adoption sprint meeting")
# looked like two separate meetings when shown verbatim.
_MEETING_TITLE_PATTERNS = [
    (re.compile(r"ai\s*adoption.*sprint", re.IGNORECASE), "AI Adoption Sprint"),
    (re.compile(r"orient.*shared\s*context|shared\s*context.*orient", re.IGNORECASE), "Orient-Me Check-in"),
]


def _meeting_timeline_title(raw_title):
    raw_title = (raw_title or "").strip()
    for pattern, label in _MEETING_TITLE_PATTERNS:
        if pattern.search(raw_title):
            return label
    words = raw_title.split()
    return " ".join(words[:4]) if words else "Meeting"


def _dedupe_meetings(metas):
    """Collapses meetings that land on the same date with the same short
    title (see _meeting_timeline_title) into one entry - two transcript
    files of "the same" real meeting (different capitalization, a re-export,
    etc.) previously showed up as two separate timeline rows on the same
    day. Keeps whichever has the richer content (more attendees, more
    agenda/achieved text) rather than just the first one found."""
    best = {}
    order = []
    for m in metas:
        if m.meeting_type:
            # A typed meeting ("Discovery 2") is only the same meeting as one
            # with the same full title, type and sequence - the 4-word title
            # alone would merge two different calls held on the same day.
            key = (m.meeting_date, (m.meeting_title or "").strip().lower(), m.meeting_type, m.meeting_sequence)
        else:
            key = (m.meeting_date, _meeting_timeline_title(m.meeting_title).lower())
        score = len(m.attendees or []) + len(m.agenda or "") + len(m.achieved or "")
        if key not in best or score > best[key][0]:
            if key not in best:
                order.append(key)
            best[key] = (score, m)
    return [best[key][1] for key in order]


def _summary_timeline_entry(s):
    """Derives a short, specific title + one-line body for a CaseSummary,
    instead of every single entry saying the same generic 'Status update'
    regardless of what it actually contains - real, direct feedback: the
    timeline should be 'to the point' and 'look like a real timeline'."""
    filled = [key for key, _label in _BRIEF_SECTION_LABELS if getattr(s, key)]
    if len(filled) >= 5:
        title, body = "Full status review", s.current_state or s.why_now
    elif not filled:
        title, body = "Status update", ""
    else:
        title, body = next(
            (label, getattr(s, key)) for key, label in _TIMELINE_HEADLINE_PRIORITY if key in filled
        )
    if s.is_manual_edit:
        title = f"✎ {title} (edited)"
    return title, _truncate(body)


# Python port of the frontend's nameWords/dedupeNames (topics/[id]/page.js) -
# kept in lockstep deliberately so the HTML brief's stakeholder list never
# drifts from what the Context Node page shows for the same topic. See that
# file's own comment for why longest-name-wins: the same person shows up
# inconsistently across transcripts ("Ayush" / "Ayush Sinha" / "Ayush Sinha
# A"), and a shorter name whose every word appears in a longer one is the
# same person named less fully.
def _name_words(name):
    return re.findall(r"[a-z0-9]+", name.lower())


def _dedupe_names(names):
    unique = list(dict.fromkeys(names))
    ordered = sorted(unique, key=lambda n: -len(_name_words(n)))
    kept = []
    for name in ordered:
        words = _name_words(name)
        covered = any(all(w in _name_words(k) for w in words) for k in kept)
        if not covered:
            kept.append(name)
    return kept


def _collect_stakeholders(topic, metas):
    names = set()
    for m in metas:
        for a in extraction.clean_attendees(m.attendees):
            names.add(a)
    for n in (topic.related_people or "").split(","):
        n = n.strip()
        if n:
            names.add(n)
    return _dedupe_names(list(names))


# A small, distinct palette so the stakeholder list reads as designed rather
# than one flat repeated color - picked deterministically from the name so
# the same person always gets the same avatar color across page loads.
_AVATAR_PALETTE = ["#0096af", "#7c5cbf", "#d0811c", "#3a8f5f", "#c0517a", "#5a6b8c"]


def _avatar_style(name):
    color = _AVATAR_PALETTE[sum(ord(c) for c in name) % len(_AVATAR_PALETTE)]
    words = [w for w in re.split(r"\s+", name.strip()) if w]
    initials = "".join(w[0].upper() for w in words[:2]) or "?"
    return color, initials


# A compact vertical timeline for the HTML brief page (per the pasted design
# reference: a simple dot-and-line, date-labeled vertical timeline) - reuses
# the exact same dedup/label logic already built for the React dashboard's
# summary_history/meeting_metadata actions (_dedupe_meetings,
# _meeting_timeline_title, _summary_timeline_entry) so the two surfaces never
# drift apart. Newest first, capped so this stays a snapshot, not a full log
# - the React Project Timeline is still the place for the complete history.
def _brief_timeline_entries(topic, metas, limit=6):
    entries = []
    for m in _dedupe_meetings(metas):
        if not m.meeting_date:
            continue
        entries.append(
            {
                "sort_key": (m.meeting_date.isoformat(), "00:00"),
                "date_label": m.meeting_date.strftime("%d %b %Y"),
                "title": _meeting_timeline_title(m.meeting_title),
                "body": _truncate(m.agenda or m.achieved or "", 90),
                "kind": "meeting",
            }
        )
    for s in topic.summaries.all().order_by("generated_at"):
        if not s.generated_at:
            continue
        title, body = _summary_timeline_entry(s)
        entries.append(
            {
                "sort_key": (s.generated_at.date().isoformat(), s.generated_at.strftime("%H:%M")),
                "date_label": s.generated_at.strftime("%d %b %Y"),
                "title": title,
                "body": body,
                "kind": "status",
            }
        )
    entries.sort(key=lambda e: e["sort_key"], reverse=True)
    return entries[:limit]


def _brief_html_page(topic, answer, summary=None):
    note_html = ""
    if not answer.get("is_llm") and answer.get("generation_note"):
        note_html = f'<p class="note">{html_escape(answer["generation_note"])}</p>'

    # Three columns, per the pasted sketch: Key Stakeholders + Key State
    # (left) - the prompt result and its supporting detail (middle) - a
    # NARROW Project Timeline (right). Stakeholders/timeline are topic-
    # level, not tied to this particular answer/summary, so they show up on
    # every visit as long as the topic has any real meeting/history data.
    metas = list(ExtractedMeta.objects.filter(ingested_file__topic=topic).select_related("ingested_file"))
    stakeholder_names = _collect_stakeholders(topic, metas)
    timeline_entries = _brief_timeline_entries(topic, metas)

    def _stakeholder_row(name):
        color, initials = _avatar_style(name)
        return (
            f'<div class="stakeholder-row"><span class="avatar" style="background:{color}">'
            f'{html_escape(initials)}</span><span class="stakeholder-name">{html_escape(name)}</span></div>'
        )

    col_a_html = (
        '<h3>👥 Key Stakeholders</h3><div class="stakeholder-list">'
        + "".join(_stakeholder_row(n) for n in stakeholder_names)
        + "</div>"
        if stakeholder_names
        else '<h3>👥 Key Stakeholders</h3><p class="tl-body">None identified yet.</p>'
    )
    # Key State quick stats - same shape as the dashboard Context Node's own
    # widget. Decisions/Commitments now have real backing models (Decision,
    # Task) so their counts are real too; Facts still has nothing to count
    # against, so it stays honestly "not yet tracked".
    if summary:
        risks_count = _count_bullets(summary.risks_and_gaps)
        links_count = len(summary.sources_used or [])
        decisions_count = topic.decisions.count()
        commitments_count = topic.commitments.count()
        col_a_html += (
            '<h3 class="key-state-h3">📌 Key State</h3><div class="key-state-list">'
            f'<div class="key-state-row"><span>Decisions</span><span class="ks-val">{decisions_count}</span></div>'
            f'<div class="key-state-row"><span>Commitments</span><span class="ks-val">{commitments_count}</span></div>'
            f'<div class="key-state-row"><span>People</span><span class="ks-val">{len(stakeholder_names)}</span></div>'
            '<div class="key-state-row"><span>Facts</span><span class="ks-val ks-empty">not yet tracked</span></div>'
            f'<div class="key-state-row"><span>Risks</span><span class="ks-val">{risks_count}</span></div>'
            f'<div class="key-state-row"><span>Important links</span><span class="ks-val">{links_count}</span></div>'
            "</div>"
        )

    def _timeline_card(e):
        # <details>/<summary> gives a native click-to-expand accordion with
        # zero JS - "when i click any timeline title then it should drop
        # down with the details" - and stays a compact, narrow row (date +
        # title only) until clicked, rather than always showing body text.
        body_html = f'<p class="tl-body">{html_escape(e["body"])}</p>' if e["body"] else ""
        return (
            f'<div class="tl-item tl-item--{e["kind"]}"><span class="tl-dot"></span>'
            f'<details class="tl-card"><summary><span class="tl-date">{html_escape(e["date_label"])}</span>'
            f'<span class="tl-title">{html_escape(e["title"])}</span></summary>'
            f'{body_html}</details></div>'
        )

    col_c_html = (
        '<h3>🗓 Project Timeline</h3><div class="timeline">'
        + "".join(_timeline_card(e) for e in timeline_entries)
        + "</div>"
        if timeline_entries
        else '<h3>🗓 Project Timeline</h3><p class="tl-body">No history yet.</p>'
    )

    # Per-paragraph source attribution (real, direct feedback: the old
    # bottom-of-page file list was "cluttered, I cannot understand which
    # paragraph is referring to what file"). Only kicks in when a real
    # structured CaseSummary is available - conversational replies, the
    # no-LLM-key fallback, and error fallbacks all still use the plain
    # flat answer + bottom source list, since there's no structure to
    # attribute paragraph-by-paragraph for those.
    has_structured_content = summary and any(
        (getattr(summary, key) or "").strip() for key, _label in _BRIEF_SECTION_LABELS
    )

    # answer_first_html is whatever directly answers the question that was
    # actually asked - it renders at the TOP of the middle column ("I need
    # to see the prompt result first then the required info"). rest_html is
    # the per-field breakdown - supporting detail, not the headline answer.
    if has_structured_content:
        files_by_path = {f.path: f for f in topic.files.all()}

        def _source_links(paths):
            links = []
            for p in paths or []:
                f = files_by_path.get(p)
                if not f:
                    continue
                name = html_escape(f.display_name or f.path)
                links.append(
                    f'<a class="edit-link" href="/api/files/{f.id}/open/" target="_blank" '
                    f'title="Open {name} in its own application to edit it">{name} · Edit ↗</a>'
                )
            return links

        # No heading here - real feedback: "when i am giving the prompt the
        # answer is comming under executive summary... i need this to come
        # under no heading." The genuine Executive Summary (topic.one_liner)
        # is a separate, always-static block - see exec_summary_html below.
        answer_first_html = ""
        if (summary.answer_summary or "").strip():
            answer_first_html = f'<p class="answer-summary">{html_escape(summary.answer_summary)}</p>'

        # No standalone "Reference documents" list anymore - real feedback:
        # "no need of reffrence documents because already there with the
        # texts" - every section below already carries its own source Edit
        # links (field_sources), so a separate top-of-page file list was
        # pure duplication.
        sections_html = ""
        field_sources = summary.field_sources or {}
        for key, label in _BRIEF_SECTION_LABELS:
            text = (getattr(summary, key) or "").strip()
            if not text:
                continue
            links = _source_links(field_sources.get(key))
            src_html = f'<p class="para-src">{"".join(links)}</p>' if links else ""
            sections_html += (
                f'<div class="brief-section"><h3>{html_escape(label)}</h3>'
                f'<p class="para">{html_escape(text)}</p>{src_html}</div>'
            )

        # "Relevant Topics for the Prompt" - a responsive multi-column grid
        # instead of one long stacked column, now that the middle column has
        # real width to spend (per the pasted design reference).
        rest_html = f'<div class="sections-grid">{sections_html}</div>' if sections_html else ""
    else:
        sources_html = ""
        if answer.get("source_files"):
            rows = "".join(
                f'<p class="src"><span class="src-name">{html_escape(s.get("display_name") or s.get("path") or "")}</span>'
                + (f'<a class="edit-link" href="/api/files/{s["id"]}/open/" target="_blank" '
                   f'title="Open this source file in its own application to edit it">Edit ↗</a>'
                   if s.get("id") else '')
                + '</p>'
                for s in answer["source_files"]
            )
            sources_html = f'<h2>Sources</h2>{rows}'
        answer_first_html = f'<div class="answer">{html_escape(answer.get("content") or "")}</div>'
        rest_html = sources_html

    # Executive Summary is a genuine short project description
    # (topic.one_liner), not the answer to whatever was just asked - kept
    # separate from answer_first_html per that same feedback.
    exec_summary_html = ""
    if (topic.one_liner or "").strip():
        exec_summary_html = (
            f'<p class="exec-eyebrow">Executive Summary</p>'
            f'<p class="answer-summary">{html_escape(topic.one_liner)}</p>'
        )

    col_b_html = f"{exec_summary_html}{answer_first_html}{rest_html}"

    # "View Full Project" - the one link back to the React dashboard from
    # this static HTML brief (opened straight in a browser, no session/SPA
    # routing). Dev-only origin, same as CORS_ALLOWED_ORIGINS[0] - this page
    # has no access to Next.js env vars since it's rendered server-side here.
    full_project_url = f"http://localhost:3000/topics/{topic.id}"

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{html_escape(topic.name)} — OrientMe</title>
<style>{BRIEF_HTML_STYLE}</style></head><body>
<p class="eyebrow">OrientMe</p>
<h1>{html_escape(topic.name)}<span class="badge">{html_escape(topic.get_topic_type_display())}</span>
<a class="view-full-project" href="{full_project_url}" target="_blank" rel="noopener">View Full Project →</a></h1>
<div class="card">
  {note_html}
  <div class="three-col">
    <div class="col-a">{col_a_html}</div>
    <div class="col-b">{col_b_html}</div>
    <div class="col-c">{col_c_html}</div>
  </div>
</div>
</body></html>"""


class TopicNamesView(APIView):
    """Public, minimal listing of {id, name} for every topic - lets a launcher
    plugin match a typed project name deterministically (e.g. Wox's
    "om <project name> <question>" syntax) instead of relying on
    resolve_topic's fuzzy/heuristic matching, which is useful when the name
    ISN'T known up front but is the wrong tool once it is. AllowAny like the
    rest of the public search surface - topic names alone (no content, no
    files, no answers) are already visible through the public search page's
    own "ambiguous" results without a login, so this exposes nothing new."""

    permission_classes = [AllowAny]

    def get(self, request):
        return Response([{"id": t.id, "name": t.name} for t in Topic.objects.all()])


class TopicBriefHtmlView(APIView):
    """The HTML page a Wox (or any launcher) result opens - "index file that
    links to timeline, that links to everything," per the transcript. AllowAny
    since it's opened straight in a browser with no session; ?q= re-asks a
    fresh question through the same _ask_topic path OrientView uses, so
    opening from a search always reflects that exact query, not just
    whatever the last saved brief happened to be."""

    permission_classes = [AllowAny]

    def get(self, request, pk=None):
        topic = get_object_or_404(Topic, pk=pk)
        question = (request.query_params.get("q") or "").strip()
        if question:
            # _ask_topic only creates a NEW CaseSummary for a real (non-
            # conversational, non-correction) question - comparing ids
            # before/after is how we tell "this answer has a fresh
            # structured summary" from "this was small talk, don't show a
            # stale summary from three questions ago alongside it."
            prior_id = topic.summaries.values_list("id", flat=True).first()
            answer = _ask_topic(topic, question)
            latest = topic.summaries.first()
            summary = latest if latest and latest.id != prior_id else None
        else:
            summary = topic.summaries.first()
            if summary:
                answer = {"content": "", "source_files": [], "is_llm": True, "generation_note": ""}
            else:
                answer = {
                    "content": "No brief yet - ask a question or ingest some files for this project first.",
                    "source_files": [],
                    "is_llm": False,
                    "generation_note": "",
                }
        html = _brief_html_page(topic, answer, summary=summary)
        return HttpResponse(html, content_type="text/html; charset=utf-8")


class OpenSourceFileView(APIView):
    """The 'Edit' link next to each cited source in the HTML brief - clicking
    it should open the respective tool on the actual source file (Word for a
    .docx, Excel for a .xlsx, the OS PDF viewer for a .pdf), not a custom
    in-app editor. Matches Venki's own 'standard tools, no custom
    functionality' framing (22 Sep sprint meeting) extended to citations:
    the brief just points at the real file and lets the OS open it.

    Looked up by IngestedFile id, never a raw path from the URL - so this can
    only ever launch a file OrientMe itself already ingested, not an
    arbitrary local path a crafted link could pass in.

    Runs the OS "open" call on whatever machine the Django process is on.
    For the common case (this backend running on your own machine) that's
    exactly what you want. If OrientMe is ever run as a shared server for
    a team, this would open the file on the SERVER, not the viewer's own
    laptop - a real limitation, same shape as the Wox plugin's own
    'server_address is per-machine' caveat - worth flagging, not hiding."""

    permission_classes = [AllowAny]

    def get(self, request, pk=None):
        f = get_object_or_404(IngestedFile, pk=pk)
        name = html_escape(f.display_name or f.path)

        if not os.path.exists(f.path):
            return HttpResponse(
                f"<!DOCTYPE html><html><body style='font-family:sans-serif;padding:40px'>"
                f"<p>Can't open <b>{name}</b> — the file no longer exists at its recorded "
                f"location:</p><p style='color:#888'>{html_escape(f.path)}</p></body></html>",
                content_type="text/html; charset=utf-8", status=404,
            )

        try:
            if sys.platform == "win32":
                os.startfile(f.path)
            elif sys.platform == "darwin":
                subprocess.Popen(["open", f.path])
            else:
                subprocess.Popen(["xdg-open", f.path])
        except OSError as e:
            return HttpResponse(
                f"<!DOCTYPE html><html><body style='font-family:sans-serif;padding:40px'>"
                f"<p>Could not open <b>{name}</b>: {html_escape(str(e))}</p></body></html>",
                content_type="text/html; charset=utf-8", status=500,
            )

        return HttpResponse(
            f"<!DOCTYPE html><html><body style='font-family:sans-serif;padding:40px;text-align:center;color:#57534a'>"
            f"<p>Opening <b>{name}</b> in its default application…</p>"
            f"<p style='font-size:12px;color:#9a9587'>You can close this tab.</p></body></html>",
            content_type="text/html; charset=utf-8",
        )


class OpenSourceFolderView(APIView):
    """The Context Node's 'Project folder' launcher - same OS-open pattern
    and same security shape as OpenSourceFileView (looked up by SourceFolder
    id, never a raw path from the URL)."""

    permission_classes = [AllowAny]

    def get(self, request, pk=None):
        folder = get_object_or_404(SourceFolder, pk=pk)
        name = html_escape(folder.path)

        if not os.path.isdir(folder.path):
            return HttpResponse(
                f"<!DOCTYPE html><html><body style='font-family:sans-serif;padding:40px'>"
                f"<p>Can't open <b>{name}</b> — this folder no longer exists at its recorded "
                f"location.</p></body></html>",
                content_type="text/html; charset=utf-8", status=404,
            )

        try:
            if sys.platform == "win32":
                os.startfile(folder.path)
            elif sys.platform == "darwin":
                subprocess.Popen(["open", folder.path])
            else:
                subprocess.Popen(["xdg-open", folder.path])
        except OSError as e:
            return HttpResponse(
                f"<!DOCTYPE html><html><body style='font-family:sans-serif;padding:40px'>"
                f"<p>Could not open <b>{name}</b>: {html_escape(str(e))}</p></body></html>",
                content_type="text/html; charset=utf-8", status=500,
            )

        return HttpResponse(
            f"<!DOCTYPE html><html><body style='font-family:sans-serif;padding:40px;text-align:center;color:#57534a'>"
            f"<p>Opening <b>{name}</b> in its file browser…</p>"
            f"<p style='font-size:12px;color:#9a9587'>You can close this tab.</p></body></html>",
            content_type="text/html; charset=utf-8",
        )


class OrientHtmlView(APIView):
    """The real 'Quicklink in Raycast as a surface' backlog item - Raycast's
    own native Quicklink feature (no custom extension needed) can save any
    plain URL with a {argument} placeholder and open it directly. /orient/
    is POST+JSON, which a Quicklink can't drive; this is the GET-only,
    single-URL equivalent - resolve + ask + render as HTML in one request,
    so 'http://<host>:8010/api/orient_html/?q={argument}' saved as one
    Raycast Quicklink is the whole setup. Works from any tool that can open
    a URL, not just Raycast - a browser bookmark with a %s search keyword
    works exactly the same way."""

    permission_classes = [AllowAny]

    def get(self, request):
        question = (request.query_params.get("q") or "").strip()
        if not question:
            return HttpResponse(
                f"<!DOCTYPE html><html><head><style>{BRIEF_HTML_STYLE}</style></head>"
                f"<body><p class='eyebrow'>OrientMe</p><h1>Type a question</h1>"
                f"<p>Add ?q=your+question to this URL.</p></body></html>",
                content_type="text/html; charset=utf-8",
            )

        result = extraction.resolve_topic(
            question, Topic.objects.all().prefetch_related("files__meta", "tasks")
        )

        if result["outcome"] == "matched":
            topic = result["topic"]
            prior_id = topic.summaries.values_list("id", flat=True).first()
            answer = _ask_topic(topic, question)
            latest = topic.summaries.first()
            summary = latest if latest and latest.id != prior_id else None
            html = _brief_html_page(topic, answer, summary=summary)
            return HttpResponse(html, content_type="text/html; charset=utf-8")

        if result["outcome"] == "ambiguous":
            from urllib.parse import quote

            rows = "".join(
                f'<div class="tl-item"><a href="/api/topics/{t.id}/brief_html/?q={quote(question)}">'
                f'{html_escape(t.name)}</a></div>'
                for t in result["topics"]
            )
            body = (
                f'<p class="eyebrow">OrientMe</p><h1>A few projects match</h1>'
                f'<div class="card"><p>Pick one:</p>{rows}</div>'
            )
        else:
            suggested = result.get("suggested_name")
            hint = f' Closest guess: "{html_escape(suggested)}".' if suggested else ""
            body = (
                f'<p class="eyebrow">OrientMe</p>'
                f'<h1>No project matches &ldquo;{html_escape(question)}&rdquo;</h1>'
                f'<div class="card"><p>{hint} Ask an admin to set this project up in OrientMe.</p></div>'
            )

        html = f"<!DOCTYPE html><html><head><style>{BRIEF_HTML_STYLE}</style></head><body>{body}</body></html>"
        return HttpResponse(html, content_type="text/html; charset=utf-8")


class AutoCreateTopicView(APIView):
    """Collapses 'create a Topic, add a folder, scan, wait, ask for a brief'
    (today's four separate manual steps) into one: give a folder path, get
    back a topic that's already being scanned and will have its first AI
    Context Brief generated automatically the moment scanning finishes - no
    upload, no separate 'add folder' step, no separate 'refresh brief' click.

    Directly answers Venki's own stated complaint from the 22 Sep transcript:
    "The problem with your approach, Ayush, I feel is that I have to go and
    add all these" - and his proposed fix: "you point out to these folders...
    we just need the location of the folder, so it is just a skill... let
    the AI do it once." The name is inferred from the folder's own name
    (no LLM call needed for that part); reuses the exact same scan+extract
    logic as TopicViewSet.ingest so the two paths never drift apart."""

    def post(self, request):
        # Accepts either the original single `folder_path` (kept for
        # backward compatibility with anything still calling it that way)
        # or a `folder_paths` list - the "create project, then add folder
        # #1, + to add folder #2, #3..." flow submits the whole list in one
        # go, same as this endpoint always did for one folder, just
        # generalized. `name` is optional - when not given, falls back to
        # the first folder's own name, same as the original behavior.
        raw_paths = request.data.get("folder_paths")
        if not raw_paths:
            single = (request.data.get("folder_path") or "").strip()
            raw_paths = [single] if single else []
        folder_paths = [p.strip() for p in raw_paths if isinstance(p, str) and p.strip()]
        if not folder_paths:
            return Response({"error": "At least one folder_path is required"}, status=400)

        missing = [p for p in folder_paths if not os.path.isdir(p)]
        if missing:
            return Response({"error": f"Folder not found: {missing[0]}"}, status=400)

        name = (request.data.get("name") or "").strip()
        if not name:
            name = os.path.basename(folder_paths[0].rstrip("\\/")) or folder_paths[0]

        topic = Topic.objects.create(name=name, topic_type="project")
        for p in folder_paths:
            SourceFolder.objects.create(topic=topic, path=p)

        def work(t, on_progress):
            summary = {"scanned": 0, "added": 0, "updated": 0, "unchanged": 0, "errors": []}
            for p in folder_paths:
                result = ingestion.ingest_folder(
                    t, p, on_progress=lambda d, tot: on_progress(d, tot, status="scanning")
                )
                summary["scanned"] += result["scanned"]
                summary["added"] += result["added"]
                summary["updated"] += result["updated"]
                summary["unchanged"] += result["unchanged"]
                summary["errors"].extend(result["errors"])

            to_extract = [
                f
                for f in t.files.all()
                if (f.extracted_text or "").strip() and not f.extraction_error
            ]
            on_progress(0, len(to_extract), status="extracting")
            for i, f in enumerate(to_extract, 1):
                _extract_and_store(f)
                on_progress(i, len(to_extract))

            # "Let the AI do it once" - the first brief is generated here,
            # automatically, not left for a person to separately ask for.
            if t.files.exists():
                _ask_topic(t, CONTEXT_BRIEF_QUESTION)

            return {
                "scanned": summary["scanned"],
                "added": summary["added"],
                "updated": summary["updated"],
                "unchanged": summary["unchanged"],
            }

        job_id = _start_scan_job(topic, work)
        return Response({"topic_id": topic.id, "job_id": job_id}, status=201)


def _connector_payload(status_row_or_slug):
    if isinstance(status_row_or_slug, ConnectorStatus):
        return {
            "slug": status_row_or_slug.slug,
            "status": status_row_or_slug.status,
            "requested_at": status_row_or_slug.requested_at,
        }
    return {"slug": status_row_or_slug, "status": "not_connected", "requested_at": None}


class ConnectorStatusView(APIView):
    """GET returns every connector that currently has a non-default status
    (i.e. someone has requested it) - the Connectors page's static catalog
    of names/logos/permissions lives in the frontend, since it's just UI
    copy; this only reports the one genuinely stateful fact per slug."""

    def get(self, request):
        return Response([_connector_payload(c) for c in ConnectorStatus.objects.all()])


class ConnectorRequestView(APIView):
    """Records that someone clicked 'Request Access' for one connector - it
    does NOT grant this app any real access. No OAuth flow happens here;
    this exists so IT/security has a clear, reviewable record of what's
    actually been asked for before any live integration is built."""

    def post(self, request, slug):
        denied = _require_settings_password(request)
        if denied:
            return denied
        obj, _ = ConnectorStatus.objects.update_or_create(
            slug=slug, defaults={"status": "requested", "requested_at": timezone.now()}
        )
        return Response(_connector_payload(obj))


class ConnectorResetView(APIView):
    """Withdraws a pending request, back to 'Not Connected'."""

    def post(self, request, slug):
        denied = _require_settings_password(request)
        if denied:
            return denied
        ConnectorStatus.objects.filter(slug=slug).update(status="not_connected", requested_at=None)
        return Response(_connector_payload(slug))


class CsrfTokenView(APIView):
    """Priming call the frontend makes once on load - Django only actually
    sets the csrftoken cookie once something calls get_token(), and that
    cookie is what every mutating request after this needs to send back as
    the X-CSRFToken header."""

    permission_classes = [AllowAny]

    def get(self, request):
        get_token(request)
        return Response({"ok": True})


ONE_LOGIN_MESSAGE = "This app has one shared login, so sign-up and email password reset are turned off."


class LoginView(APIView):
    """Signs in the one shared login only (settings.SINGLE_LOGIN_USERNAME).
    Any other username - including accounts that still exist in the database -
    gets the same generic error as a wrong password, so this can't be used to
    find out which accounts exist."""

    permission_classes = [AllowAny]

    def post(self, request):
        username = (request.data.get("username") or "").strip()
        password = request.data.get("password") or ""
        if username.lower() != django_settings.SINGLE_LOGIN_USERNAME.lower():
            return Response({"error": "Incorrect username or password."}, status=400)
        # The configured spelling, not what was typed: Django's own username
        # match is case-sensitive, and "User" / "USER" should open the same login.
        user = authenticate(request, username=django_settings.SINGLE_LOGIN_USERNAME, password=password)
        if user is None:
            return Response({"error": "Incorrect username or password."}, status=400)
        django_login(request, user)
        return Response(_profile_payload(user))


class RegisterView(APIView):
    """Switched off: the app has one shared login (Ayush, 8 Oct 2026), so no
    account can be created from outside."""

    permission_classes = [AllowAny]

    def post(self, request):
        return Response({"error": ONE_LOGIN_MESSAGE}, status=403)


class PasswordResetRequestView(APIView):
    """Switched off with sign-up: with one shared login there is no email
    address to send a reset link to. The login's password is changed from the
    Profile page while signed in, or from the command line
    (`python manage.py changepassword <username>`)."""

    permission_classes = [AllowAny]

    def post(self, request):
        return Response({"error": ONE_LOGIN_MESSAGE}, status=403)


class PasswordResetConfirmView(APIView):
    """Switched off - see PasswordResetRequestView."""

    permission_classes = [AllowAny]

    def post(self, request):
        return Response({"error": ONE_LOGIN_MESSAGE}, status=403)


class LogoutView(APIView):
    def post(self, request):
        django_logout(request)
        return Response({"ok": True})


class MeView(APIView):
    """Whether anyone is logged in right now, and who - the frontend's
    AuthProvider calls this once on load to decide whether to show the app
    or redirect to /login."""

    permission_classes = [AllowAny]

    def get(self, request):
        if not request.user.is_authenticated:
            return Response({"authenticated": False})
        return Response({"authenticated": True, **_profile_payload(request.user)})


class ChangePasswordView(APIView):
    """Self-service password change for the signed-in login. This is the
    login's own password; it has nothing to do with the settings password
    (settings.SETTINGS_EDIT_PASSWORD), which guards the Settings page."""

    def post(self, request):
        old_password = request.data.get("old_password") or ""
        new_password = request.data.get("new_password") or ""
        if not request.user.check_password(old_password):
            return Response({"error": "Current password is incorrect."}, status=400)
        if len(new_password) < 6:
            return Response({"error": "New password must be at least 6 characters."}, status=400)
        request.user.set_password(new_password)
        request.user.save()
        # Changing the password rotates Django's session auth hash, which
        # would otherwise silently log this same request's session out -
        # this keeps the person signed in through their own password change.
        update_session_auth_hash(request, request.user)
        return Response({"ok": True})


class UpdateProfileView(APIView):
    """Self-service display-name change."""

    def post(self, request):
        display_name = (request.data.get("display_name") or "").strip()
        if display_name:
            parts = display_name.split(" ", 1)
            request.user.first_name = parts[0]
            request.user.last_name = parts[1] if len(parts) > 1 else ""
            request.user.save()
        return Response(_profile_payload(request.user))


# ===========================================================================
# 5 Oct 2026 - additive sales-oriented features (file metadata, meeting
# types, human notes, business timeline, contacts, metadata CSV).
# Nothing above this line was removed or re-purposed.
# ===========================================================================

_TIMELINE_DOC_TYPES = ("proposal", "quotation_sow", "prd_brd", "project_charter", "project_plan", "opportunity_scorecard")
_TIMELINE_KIND_ORDER = {"meeting": 0, "email": 1, "document": 2, "note": 3}
MAX_NOTE_LENGTH = 2000


def _meeting_display_title(m):
    return doc_meta.meeting_display_title(
        _meeting_timeline_title(m.meeting_title), m.meeting_title, m.meeting_type, m.meeting_sequence
    )


def _meeting_payload(m, include_turns=False):
    """The meeting_metadata item shape: every key it always had, plus the
    meeting type/sequence, the "who said what" summary and the meeting's notes."""
    payload = {
        "id": m.id,
        "file_id": m.ingested_file_id,
        "file_display_name": m.ingested_file.display_name,
        "file_path": m.ingested_file.path,
        "meeting_title": m.meeting_title,
        "timeline_title": _meeting_display_title(m),
        "meeting_date": m.meeting_date.isoformat() if m.meeting_date else None,
        "meeting_time": m.meeting_time,
        "attendees": extraction.clean_attendees(m.attendees),
        "agenda": m.agenda,
        "achieved": m.achieved,
        "meeting_type": m.meeting_type,
        "meeting_type_label": doc_meta.MEETING_TYPE_LABELS.get(m.meeting_type, ""),
        "meeting_sequence": m.meeting_sequence,
        "meeting_type_source": m.meeting_type_source,
        "speaker_turn_count": len(m.speaker_turns or []),
        "speaker_summary": extraction.summarize_speakers(m.speaker_turns),
        "notes": [
            {"id": n.id, "text": n.text, "author": n.author, "created_at": n.created_at.isoformat()}
            for n in m.notes.all()
        ],
    }
    if include_turns:
        payload["speaker_turns"] = m.speaker_turns or []
    return payload


def _business_timeline_events(topic):
    """Business events for a topic, oldest first: meetings (type + sequence in
    the title), emails (by document_date), key documents with their version,
    and human notes. Additive to the app's own timeline - see API_CONTRACT.md."""
    events = []

    def event(kind, date_iso, title, body="", **extra):
        row = {
            "kind": kind, "date": date_iso, "title": title, "body": body, "approx_date": False,
            "file_id": None, "meta_id": None, "note_id": None, "doc_type": "", "version_label": "",
            "meeting_type": "", "meeting_sequence": None, "author": "", "meeting_title": "",
        }
        row.update(extra)
        events.append(row)

    metas = (
        ExtractedMeta.objects.filter(ingested_file__topic=topic, meeting_date__isnull=False)
        .select_related("ingested_file")
        .order_by("meeting_date", "ingested_file__first_added_at")
    )
    for m in _dedupe_meetings(metas):
        event(
            "meeting", m.meeting_date.isoformat(), _meeting_display_title(m),
            _truncate(m.achieved or m.agenda or "", 160),
            file_id=m.ingested_file_id, meta_id=m.id, meeting_type=m.meeting_type,
            meeting_sequence=m.meeting_sequence,
        )

    files = topic.files.filter(doc_type__in=("email",) + _TIMELINE_DOC_TYPES).exclude(meta_state="error")
    for f in files:
        when = f.document_date
        approx = when is None
        if approx:
            when = f.first_added_at.date()
        if f.doc_type == "email":
            subject = doc_meta.email_subject(f.extracted_text)
            event(
                "email", when.isoformat(), subject or f.display_name or "Email", f.signal,
                approx_date=approx, file_id=f.id, doc_type=f.doc_type, version_label=f.version_label,
            )
        else:
            label = doc_meta.DOC_TYPE_LABELS.get(f.doc_type, "Document")
            title = f"{label} {f.version_label}".strip()
            event(
                "document", when.isoformat(), title, f.signal,
                approx_date=approx, file_id=f.id, doc_type=f.doc_type, version_label=f.version_label,
            )

    for n in topic.meeting_notes.select_related("meta"):
        first_line = " ".join((n.text or "").split())
        event(
            "note", n.created_at.date().isoformat(), "Note: " + _truncate(first_line, 70), n.text,
            note_id=n.id, meta_id=n.meta_id, author=n.author,
            meeting_title=n.meta.meeting_title if n.meta_id else "",
        )

    events.sort(key=lambda e: (e["date"], _TIMELINE_KIND_ORDER[e["kind"]], e["file_id"] or e["note_id"] or e["meta_id"] or 0))
    return events


# ---- metadata CSV --------------------------------------------------------
METADATA_CSV_COLUMNS = [
    "file", "document_type", "topic_tags", "signal", "state", "seconds", "review_notes",  # Siddharth's contract
    "phase", "version", "doc_date", "participants",  # optional, to the right
]
_DELIVERY_DOC_TYPES = ("prd_brd", "project_charter", "project_plan", "stakeholder_map")
_DELIVERY_MEETING_TYPES = ("kickoff", "standup", "review")


def _csv_safe(value):
    """Neutralise spreadsheet formula injection (a cell starting = + @ or a
    '-' that is not a plain negative number would be run as a formula by
    Excel); email-derived text is not trusted."""
    value = "" if value is None else str(value)
    if value and (value[0] in "=+@\t\r" or (value[0] == "-" and not re.match(r"^-\d+(\.\d+)?$", value))):
        return "'" + value
    return value


def _csv_file_label(f):
    path = f.path or ""
    norm = path.replace("\\", "/")
    for folder in f.topic.folders.all():
        base = (folder.path or "").replace("\\", "/").rstrip("/")
        if base and norm.lower().startswith(base.lower() + "/"):
            return norm[len(base) + 1:]
    if path.startswith(("pasted:", "mbox:", "ics:")):
        return f.display_name or path
    return f.display_name or os.path.basename(norm) or path


def _csv_phase(f):
    topic = f.topic
    meta = getattr(f, "meta", None)
    if f.doc_type in _DELIVERY_DOC_TYPES or (meta is not None and meta.meeting_type in _DELIVERY_MEETING_TYPES):
        return "Delivery"
    if topic.topic_type in ("opportunity", "customer") or topic.stage:
        return "Pre-sales"
    return ""


def _csv_participants(f):
    if f.doc_type == "email":
        names = doc_meta.email_participants(f.extracted_text)
    else:
        meta = getattr(f, "meta", None)
        names = extraction.clean_attendees(meta.attendees) if meta is not None else []
    return "; ".join(names)


def _metadata_csv_row(f, with_topic):
    meta = getattr(f, "meta", None)
    state = f.meta_state or ("error" if f.extraction_error else "")
    when = f.document_date or (meta.meeting_date if meta is not None else None)
    notes = f.review_notes or (f.extraction_error if state == "error" else "")
    row = [
        _csv_file_label(f),
        doc_meta.DOC_TYPE_LABELS.get(f.doc_type, ""),
        f.topic_tags,
        f.signal,
        state,
        f"{f.meta_seconds:.1f}" if f.meta_seconds is not None else "",
        notes,
        _csv_phase(f),
        f.version_label,
        when.isoformat() if when else "",
        _csv_participants(f),
    ]
    if with_topic:
        row.append(f.topic.name)
    return [_csv_safe(c) for c in row], (when.isoformat() if when else "9999-12-31")


def _metadata_csv_response(files, filename, with_topic=False):
    rows = [_metadata_csv_row(f, with_topic) for f in files]
    rows.sort(key=lambda r: (r[1], r[0][0].lower()))
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(METADATA_CSV_COLUMNS + (["topic"] if with_topic else []))
    for row, _sort in rows:
        writer.writerow(row)
    response = HttpResponse(buf.getvalue(), content_type="text/csv; charset=utf-8")
    safe_name = re.sub(r'[^A-Za-z0-9._ -]+', "_", filename).strip() or "metadata.csv"
    response["Content-Disposition"] = f'attachment; filename="{safe_name}"'
    return response


class GlobalMetadataCsvView(APIView):
    """GET /api/metadata_csv/ - every ingested file across every project (or
    one project with ?topic_id=): the same CSV as TopicViewSet.metadata_csv
    with one extra trailing "topic" column."""

    def get(self, request):
        qs = IngestedFile.objects.select_related("topic", "meta").prefetch_related("topic__folders")
        topic_id = request.query_params.get("topic_id")
        if topic_id:
            qs = qs.filter(topic_id=topic_id)
        return _metadata_csv_response(qs, "orientme-metadata.csv", with_topic=True)


# ---- file metadata edit / confirm ----------------------------------------
class FileMetadataView(APIView):
    """GET/PATCH /api/files/<id>/metadata/ - read or correct one file's
    metadata. A PATCH that changes doc_type / topic_tags / signal /
    version_label / document_date marks the row "corrected" (and doc_type as
    manually set); review_notes can be edited without changing the state."""

    EDITABLE = ("doc_type", "topic_tags", "signal", "version_label", "document_date", "review_notes")

    def _payload(self, f):
        return {"id": f.id, "topic_id": f.topic_id, **file_metadata_payload(f)}

    def get(self, request, pk=None):
        return Response(self._payload(get_object_or_404(IngestedFile, pk=pk)))

    def patch(self, request, pk=None):
        f = get_object_or_404(IngestedFile, pk=pk)
        data = request.data
        present = [k for k in self.EDITABLE if k in data]
        if not present:
            return Response({"error": "Send at least one of: " + ", ".join(self.EDITABLE)}, status=400)

        errors, changes = {}, {}
        if "doc_type" in data:
            value = str(data["doc_type"] or "").strip()
            if value and value not in dict(DOC_TYPES):
                errors["doc_type"] = "Unknown document type. Allowed: " + ", ".join(dict(DOC_TYPES))
            else:
                changes["doc_type"] = value
        if "topic_tags" in data:
            changes["topic_tags"] = ", ".join(doc_meta.normalize_tags(data["topic_tags"]))
        if "signal" in data:
            value = " ".join(str(data["signal"] or "").split())
            if len(value) > 400:
                errors["signal"] = "At most 400 characters."
            else:
                changes["signal"] = value
        if "version_label" in data:
            value = " ".join(str(data["version_label"] or "").split())
            if len(value) > 30:
                errors["version_label"] = "At most 30 characters."
            else:
                changes["version_label"] = value
        if "document_date" in data:
            raw = data["document_date"]
            if raw in (None, ""):
                changes["document_date"] = None
            else:
                try:
                    changes["document_date"] = datetime.strptime(str(raw)[:10], "%Y-%m-%d").date()
                except ValueError:
                    errors["document_date"] = "Use YYYY-MM-DD."
        if "review_notes" in data:
            changes["review_notes"] = str(data["review_notes"] or "").strip()
        if errors:
            return Response({"errors": errors}, status=400)

        fields = []
        material_change = False
        for key, value in changes.items():
            if getattr(f, key) != value:
                setattr(f, key, value)
                fields.append(key)
                if key != "review_notes":
                    material_change = True
        if "doc_type" in fields:
            f.doc_type_source = "manual"
            fields.append("doc_type_source")
        if material_change and f.meta_state != "corrected":
            f.meta_state = "corrected"
            fields.append("meta_state")
        if fields:
            f.save(update_fields=fields)  # update_fields: last_ingested_at is left alone
        return Response(self._payload(f))


class FileMetadataConfirmView(APIView):
    """POST /api/files/<id>/confirm/ - a person vouches for the current
    metadata: generated_unconfirmed (or never-filled) -> confirmed. Already
    corrected rows stay "corrected"; an unreadable (error) file cannot be
    confirmed."""

    def post(self, request, pk=None):
        f = get_object_or_404(IngestedFile, pk=pk)
        if f.meta_state == "error":
            return Response({"error": "This file could not be read, so there is nothing to confirm."}, status=400)
        if f.meta_state != "corrected" and f.meta_state != "confirmed":
            f.meta_state = "confirmed"
            f.save(update_fields=["meta_state"])
        return Response({"id": f.id, "topic_id": f.topic_id, **file_metadata_payload(f)})


# ---- meeting type / sequence ---------------------------------------------
class MeetingDetailView(APIView):
    """GET/PATCH /api/meetings/<meta_id>/ - one meeting (ExtractedMeta). PATCH
    meeting_type and/or meeting_sequence by hand; a manual choice is never
    overwritten by auto-detection on re-ingest."""

    def _get(self, pk):
        return get_object_or_404(ExtractedMeta.objects.select_related("ingested_file"), pk=pk)

    def get(self, request, pk=None):
        return Response(_meeting_payload(self._get(pk), include_turns=True))

    def patch(self, request, pk=None):
        m = self._get(pk)
        data = request.data
        if "meeting_type" not in data and "meeting_sequence" not in data:
            return Response({"error": "Send meeting_type and/or meeting_sequence."}, status=400)
        errors = {}
        if "meeting_type" in data:
            value = str(data["meeting_type"] or "").strip()
            if value and value not in dict(MEETING_TYPES):
                errors["meeting_type"] = "Allowed: " + ", ".join(dict(MEETING_TYPES))
            else:
                m.meeting_type = value
        if "meeting_sequence" in data:
            raw = data["meeting_sequence"]
            if raw in (None, ""):
                m.meeting_sequence = None
            else:
                try:
                    seq = int(raw)
                    if not 1 <= seq <= 99:
                        raise ValueError
                    m.meeting_sequence = seq
                except (TypeError, ValueError):
                    errors["meeting_sequence"] = "A whole number from 1 to 99, or null."
        if errors:
            return Response({"errors": errors}, status=400)
        m.meeting_type_source = "manual"
        m.save(update_fields=["meeting_type", "meeting_sequence", "meeting_type_source"])
        return Response(_meeting_payload(m, include_turns=True))
