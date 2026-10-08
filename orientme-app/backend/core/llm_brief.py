"""Turns a topic's ingested files + a natural-language question into the
brief OrientMe's PRD describes - same dual-provider pattern as this
workspace's other LLM integrations (Weekly Summary Agent's llm_summary.py,
HR Hiring Agent's scorer.py): OpenRouter by default (matching what's already
running at Maarga), structured via a tool call so the response is always the
fields needed, never free text to re-parse.

Falls back to a plain "here's what was found, unsummarized" response if no
API key is configured yet, or if the call fails - never blocks answering,
same rule every other LLM integration in this workspace follows.
"""

import json
import re

# Deterministic small-talk detection, checked BEFORE any LLM call. Asking
# the model to self-classify via is_conversational sounds right but doesn't
# hold up in practice: forcing tool_choice to submit_orientme_brief biases
# the model toward always filling in a full brief regardless of what the
# prompt says (confirmed live: a plain "hi" still came back as a complete
# 8-part brief about the topic in general). Matching obvious small talk in
# plain Python is reliable, free, and doesn't depend on model behavior -
# only exact/near-exact matches so a real question is never misclassified.
_SMALLTALK_RE = re.compile(
    r"^(hi+|hello+|hey+|yo+|sup|howdy|good\s*(morning|afternoon|evening|night)|"
    r"thanks?( you)?|thank\s*you|ok(ay)?|k|bye|goodbye|see\s*ya|how\s*are\s*you"
    r"|what'?s\s*up|no)[!.?\s]*$",
    re.IGNORECASE,
)

_SMALLTALK_REPLIES = {
    "default": "Hi! Ask me anything about this project — what's the current state, what did we commit to, or what happened in the last meeting.",
    "thanks": "You're welcome!",
    "bye": "Bye! Come back anytime you need to get oriented on this.",
}


def _smalltalk_reply(question):
    q = question.strip().lower()
    if re.match(r"^thanks?( you)?[!.\s]*$", q):
        return _SMALLTALK_REPLIES["thanks"]
    if re.match(r"^(bye|goodbye|see\s*ya)[!.\s]*$", q):
        return _SMALLTALK_REPLIES["bye"]
    return _SMALLTALK_REPLIES["default"]

SUBMIT_BRIEF_TOOL_OPENAI = {
    "type": "function",
    "function": {
        "name": "submit_orientme_brief",
        "description": (
            "Submit the answer. Up to 12 possible sections (why now, current state, history, "
            "what the customer thinks, customer need, proposed solution, latest updates, "
            "decisions made, meeting prep, promises made/waiting-on, next actions, open questions/"
            "risks) plus top links (sources_used) - but this is a MENU, not a fixed template. "
            "Fill in only the sections the actual question calls for; leave the rest as empty "
            "strings. A narrow question gets a narrow answer, not all 12 sections padded out."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "is_conversational": {
                    "type": "boolean",
                    "description": (
                        "True if this message is a greeting, small talk, thanks, or anything else "
                        "that isn't actually asking for orientation on the topic - e.g. 'hi', "
                        "'thanks', 'are you there?'. When true, only answer_summary is used (a "
                        "normal, natural reply) and every other field is ignored, so leave them all "
                        "as empty strings/lists - never fill them with placeholder text like 'n/a' or "
                        "force a brief onto a message that isn't asking for one. False for any real "
                        "question about the topic, however small."
                    ),
                },
                "why_now": {
                    "type": "string",
                    "description": "Why this matters right now, in one or two sentences.",
                },
                "why_now_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which of the provided file paths this specific why_now text came from. Empty list if why_now is empty or not grounded in a specific file.",
                },
                "current_state": {
                    "type": "string",
                    "description": (
                        "\"Current Position\" - the executive-recap section: where things actually stand "
                        "right now, based only on the ingested files. Write as 2-6 short bullet facts (one "
                        "per line, each starting with \"- \"), not a flowing paragraph - concrete things "
                        "established/done, not a narrative summary. This is read first and read fastest, so "
                        "it should work as a standalone 5-8 bullet recap of the whole thing even if every "
                        "other section is empty. Example shape: \"- Procurement conversation completed\\n"
                        "- Researching the DMS/SFA landscape\\n- Need a sharper proposal for distributor "
                        "forecasting\"."
                    ),
                },
                "current_state_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths current_state actually came from.",
                },
                "history": {"type": "string", "description": "Only the past events actually relevant to answering the question."},
                "history_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths history actually came from.",
                },
                "customer_thoughts": {
                    "type": "string",
                    "description": (
                        "What the customer/other party has actually stated they think, want, or are "
                        "concerned about - only if this topic involves one. Mark any inference clearly "
                        "as inference (e.g. \"likely\", \"appears to be\"), never state a guess as fact. "
                        "Empty string if not applicable or not covered."
                    ),
                },
                "customer_thoughts_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths customer_thoughts actually came from.",
                },
                "customer_need": {
                    "type": "string",
                    "description": (
                        "What problem the customer/other party is actually trying to solve - only if this "
                        "topic involves one. Write as 1-3 short bullet lines (each starting with \"- \"). "
                        "Empty string if not applicable or not stated."
                    ),
                },
                "customer_need_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths customer_need actually came from.",
                },
                "proposed_solution": {
                    "type": "string",
                    "description": (
                        "What has actually been proposed or committed to so far (by us, not a "
                        "recommendation for what to do next - that's next_step). Write as 1-3 short bullet "
                        "lines (each starting with \"- \"). Empty string if nothing's been proposed yet."
                    ),
                },
                "proposed_solution_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths proposed_solution actually came from.",
                },
                "latest_updates": {
                    "type": "string",
                    "description": (
                        "What specifically changed since the last meeting/update - only fill this when the "
                        "question is about what's new/changed, not a general status question (that's "
                        "current_state). Write as 1-3 short bullet lines (each starting with \"- \"). Empty "
                        "string otherwise."
                    ),
                },
                "latest_updates_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths latest_updates actually came from.",
                },
                "decisions_made": {
                    "type": "string",
                    "description": (
                        "Important decisions already agreed upon and settled - distinct from next_step "
                        "(a recommendation) and promises_made (still open). Write as 1-3 short bullet lines "
                        "(each starting with \"- \"). Empty string if none were actually decided."
                    ),
                },
                "decisions_made_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths decisions_made actually came from.",
                },
                "meeting_prep": {
                    "type": "string",
                    "description": (
                        "Only fill this when the question is specifically about preparing for an upcoming "
                        "meeting (e.g. 'what should I focus on today', 'prep me for this call') - "
                        "3-5 short bullet lines (each starting with \"- \") naming the specific things to "
                        "focus on in that meeting. Empty string for any other kind of question, including "
                        "general status questions."
                    ),
                },
                "meeting_prep_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths meeting_prep actually came from.",
                },
                "promises_made": {
                    "type": "string",
                    "description": (
                        "\"Waiting\" - open commitments made by either side that haven't been closed out "
                        "yet, Venki's own framing: 'what am I waiting for'. Write as short bullet lines "
                        "(one per line, each starting with \"- \"), e.g. \"- Ravi feedback\\n- Procurement "
                        "response\" - not full sentences. Empty string if none."
                    ),
                },
                "promises_made_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths promises_made actually came from.",
                },
                "next_step": {
                    "type": "string",
                    "description": (
                        "\"Next\" - Venki's own framing: 'what are the next actions'. Write as short "
                        "bullet lines (one per line, each starting with \"- \"), e.g. \"- Draft AI "
                        "proposition\\n- Talk to Category IT\" - not full sentences. Usually 1-3 distinct "
                        "next actions. Where this is an opportunity/commitment-style topic, one bullet can "
                        "be the minimum acceptable commitment to walk away with (the floor, not just the "
                        "ideal outcome) - per the PRD's own output contract. This is a RECOMMENDATION, not "
                        "a stated fact."
                    ),
                },
                "next_step_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths the reasoning behind next_step actually came from. Can be empty if next_step is purely a recommendation with no single supporting file.",
                },
                "risks_and_gaps": {
                    "type": "string",
                    "description": (
                        "\"Open questions\" - Venki's own framing: 'what are the open questions' - "
                        "contradictions, stale information, or missing inputs. Write as short bullet lines "
                        "(one per line, each starting with \"- \"), e.g. \"- DMS API availability\\n- Data "
                        "ownership?\" - not full sentences. State plainly if nothing stands out. When the "
                        "source material makes clear WHO an open question is actually directed at (e.g. "
                        "a manager assigned it to a specific person, or a question is waiting on a named "
                        "person's answer), name that person in the bullet - e.g. \"- Data ownership - "
                        "open question to Venki\" rather than a bare, unaddressed question. Never invent a "
                        "name that isn't actually in the source material."
                    ),
                },
                "risks_and_gaps_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths risks_and_gaps actually came from.",
                },
                "answer_summary": {"type": "string", "description": "A direct 2-4 sentence answer to the actual question asked, for the top of the reply."},
                "sources_used": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "\"Open first\": the 3-5 single most valuable file paths (from the ones provided) for a person to actually open before or during the thing this question is about - not a full citation list, the short list worth opening first. Also doubles as this answer's source attribution. Empty list if none were relevant.",
                },
                "gaps_no_source_found": {
                    "type": "string",
                    "description": "Plainly state anything the question asked for that the ingested files simply don't cover - never invent an answer to fill this gap.",
                },
            },
            "required": ["is_conversational", "answer_summary", "current_state", "sources_used"],
        },
    },
}

PROMPT_TEMPLATE = """You are OrientMe, an orientation assistant for a specific topic (a project, \
opportunity, person, customer, area, or process). You answer questions using ONLY the files \
provided below - never invent facts, dates, names, or outcomes that aren't in them.

Rules:
- First decide is_conversational. If the message is a greeting, small talk, thanks, or anything \
  else that isn't actually asking for orientation on the topic, set is_conversational to true, \
  write a normal, natural, friendly reply in answer_summary, and leave every other field empty \
  ("" or []) - do not force a brief's worth of sections onto a message that didn't ask for one, \
  and never fill an inapplicable field with "n/a" or similar placeholder text.
- Otherwise (a real question, however small), set is_conversational to false - but the shape of \
  the answer must be DYNAMIC, driven by what was actually asked, never a fixed template. Fill in \
  ONLY the sections that are actually relevant to THIS question; leave every other section as an \
  empty string ("") - an empty section is correct, not incomplete, when the question didn't call \
  for it.
- IMPORTANT: "OrientMe" or "orient me" appearing in the question is just this assistant's own \
  name/habitual prefix (people type it before every question, the way you'd say "hey Google") - \
  it is NEVER itself a signal that the question is broad. Judge breadth ONLY from what is actually \
  being asked after that prefix. "Orient me, what was the task given to Ayush next" is a NARROW \
  question (it's asking for ONE specific thing - the next task) and must get a narrow answer - \
  next_step alone (plus current_state only if genuinely needed for context), NOT all seven \
  sections. Compare: "orient me on this project" or "give me the full status" ARE genuinely broad \
  because of what they ask for, not because they contain the word "orient" - those legitimately \
  fill in most sections. When in doubt, default to narrower and fewer sections, never wider.
- Mechanical rule, apply it literally: before writing anything, count how many DISTINCT things \
  the question is actually asking for. "What's the next task for Ayush" asks for exactly ONE \
  thing (the next action) - fill in next_step and STOP; do not also add current_state, history, \
  why_now, customer_thoughts, or any other section just because you know them - knowing more than \
  was asked is not a reason to say more than was asked. "What's the status and what are the \
  risks" asks for exactly TWO things - fill in current_state and risks_and_gaps, nothing else. \
  Only a genuinely open-ended request ("orient me", "give me the full picture", "catch me up") \
  has no fixed count and may use every section that has real content. A one-thing question that \
  gets a four-or-five-section answer is a mistake every time - re-read the question and cut it \
  down before submitting.
- Several sections exist ONLY for a specific kind of question and should almost always stay empty: \
  meeting_prep is ONLY for "help me prepare for [a meeting]" style questions, never a general \
  status question. latest_updates is ONLY for "what changed / what's new since last time" \
  questions, never a general status question (current_state covers that). decisions_made, \
  customer_need, and proposed_solution only get filled when the question specifically asks about \
  decisions, the customer's problem, or what's been proposed, respectively - not as a default \
  add-on to a broader answer.
- Every claim must be traceable to one of the source files below. List exactly which files \
  actually informed your answer in sources_used.
- ALSO fill in the matching "_sources" list for each section you write (why_now_sources, \
  current_state_sources, history_sources, customer_thoughts_sources, promises_made_sources, \
  next_step_sources, risks_and_gaps_sources) - the specific file path(s) THAT SECTION's own text \
  came from, not just the overall sources_used list. This lets the reader see which file backs \
  which paragraph instead of one undifferentiated list. Leave a section's _sources list empty if \
  that section itself is empty, or if it's a recommendation/inference with no single file behind it.
- If the files don't cover something the question asks about, say so plainly in \
  gaps_no_source_found - never guess or fill the gap with plausible-sounding invention.
- Clearly distinguish four different things in your wording, never blur them together: FACT (state \
  it plainly, it's in a file), INFERENCE (say "likely" or "appears to be" - never state a guess as \
  settled fact), RECOMMENDATION (next_step is always a recommendation, not a fact - say so implicitly \
  by its framing), and UNCERTAINTY/MISSING EVIDENCE (if something is genuinely unclear or unstated, \
  say so plainly in the relevant section or in gaps_no_source_found - never paper over a gap with a \
  confident-sounding guess).
- current_state, promises_made, next_step, and risks_and_gaps are each rendered as a short bullet \
  list on screen, not a paragraph - write them that way: one short fact/item per line, each line \
  starting with "- ", never a flowing sentence joined with "and"/commas. 2-4 bullets per section is \
  plenty; a single very short section can be just one bullet.
- Keep every section factual and concise - this is meant to be read in under a minute. As a concrete \
  target: the sections you DO fill in, combined, should read as roughly 25-30 lines or fewer when \
  rendered - tighten your wording rather than write long paragraphs. This is a target for the sections \
  you choose to fill, not a reason to add sections that weren't asked for.

Scope: {topic_name} ({topic_type})
{manual_state_block}{manual_notes_block}{sales_recap_block}
Question being asked: {question}

Source files available (path, then content):
{files_block}

Call submit_orientme_brief with the finished brief."""


# Rendered only when a ProjectState row with real text exists for this topic
# (see models.ProjectState) - a person's own explicit statement of where
# things stand, distinct from and higher-priority than the source files,
# per the manual/AI precedence the product spec asked for ("manual > recent
# verified > structured > source docs", surfaced rather than silently
# overridden on conflict).
MANUAL_STATE_BLOCK_TEMPLATE = """
The user has manually confirmed the following as the CURRENT STATE of this project - treat it as \
more current and authoritative than the source files below unless a source file is clearly newer. \
If a source file conflicts with it, say so plainly in your answer rather than silently picking one.

Manually confirmed current state (as of {updated_at}):
{current_position}
"""


# Rendered only when the topic has MeetingNote rows (5 Oct 2026) - the short
# human notes people add after a meeting. Same style as the block above, next
# to it in the prompt. HIGH-SIGNAL: trusted over inference, conflicts flagged.
MANUAL_NOTES_BLOCK_TEMPLATE = """
The team has added the following short HUMAN NOTES (usually one or two lines written right after a \
meeting). They are HIGH-SIGNAL and TRUSTED: treat them as more reliable than anything you would \
infer from the source files, and let them guide what matters most. If a note conflicts with a source \
file, say so plainly in your answer (for example in risks_and_gaps) rather than silently picking one. \
A note is not a file: never put a note in a _sources list - cite only the file paths below.

Human notes (trusted), oldest first:
{notes}
"""

MAX_NOTES_IN_PROMPT = 40
MAX_NOTE_CHARS = 600


def _build_notes_block(topic):
    """Dated "Human notes (trusted)" block, or "" when the topic has no notes
    (so a topic without notes gets exactly the prompt it always got)."""
    if topic is None or not getattr(topic, "pk", None):
        return ""
    notes = list(topic.meeting_notes.select_related("meta").order_by("-created_at", "-id")[:MAX_NOTES_IN_PROMPT])
    notes.reverse()  # oldest first
    lines = []
    for n in notes:
        text = " ".join((n.text or "").split())
        if not text:
            continue
        if len(text) > MAX_NOTE_CHARS:
            text = text[: MAX_NOTE_CHARS - 3].rstrip() + "..."
        about = ""
        if n.meta_id:
            when = n.meta.meeting_date.strftime("%d %b %Y") if n.meta.meeting_date else "undated"
            about = f" (about the meeting '{(n.meta.meeting_title or 'untitled').strip()}', {when})"
        author = f" - {n.author}" if n.author else ""
        lines.append(f"- {n.created_at.strftime('%d %b %Y')}{about}: {text}{author}")
    if not lines:
        return ""
    return MANUAL_NOTES_BLOCK_TEMPLATE.format(notes="\n".join(lines))


# Appended ONLY for opportunity / customer topics (5 Oct 2026): a sales-
# oriented structure for a broad recap, mapped onto the EXISTING 12 fields (no
# schema change). Every other topic type keeps the exact prompt it had.
SALES_RECAP_BLOCK_TEMPLATE = """
This topic is a sales {kind}.{facts} When the request is a broad one (a recap, "catch me up", "where do \
things stand", preparing for the next meeting), cover the following WHERE EVIDENCE EXISTS in the files \
or the human notes - and leave a part out entirely when there is no evidence, never invent it - using \
the existing sections like this:
- Account snapshot, the opportunity and its scope (what the customer is exploring, scope, current \
stage): current_state, and customer_need for the problem they want solved.
- Stakeholders with role and stance (who is who on the customer side and on ours, and where each one \
stands - only what was actually said or clearly shown): customer_thoughts.
- Meeting-by-meeting recap, in DATE ORDER, oldest first - for each meeting: its type (intro, discovery, \
solution, commercial, ...), date and outcome: history.
- Proposal / quotation / SOW status with the VERSION (V1, V2, Final), its date, what changed and what \
feedback it drew: proposed_solution.
- Open items - what is waiting on whom: promises_made; open questions and risks: risks_and_gaps.
- Next step - the single best next step: next_step.
A narrow question still gets a narrow answer - this structure is for broad requests.
"""

SALES_TOPIC_TYPES = ("opportunity", "customer")


def _build_sales_recap_block(topic):
    if topic is None or getattr(topic, "topic_type", "") not in SALES_TOPIC_TYPES:
        return ""
    facts = []
    if (getattr(topic, "customer_name", "") or "").strip():
        facts.append(f"Customer: {topic.customer_name.strip()}.")
    if getattr(topic, "stage", ""):
        facts.append(f"Stage (set by a person): {topic.get_stage_display()}.")
    return SALES_RECAP_BLOCK_TEMPLATE.format(
        kind=topic.topic_type, facts=(" " + " ".join(facts)) if facts else ""
    )


def _doc_meta_line(f):
    """One "[Document: ...]" line for a file block - only for sales topics, and
    only when something is actually known (so unclassified files add nothing)."""
    bits = []
    label = f.get_doc_type_display() if getattr(f, "doc_type", "") else ""
    if label:
        bits.append(label)
    if getattr(f, "version_label", ""):
        bits.append(f"version {f.version_label}")
    meta = getattr(f, "meta", None)
    if meta is not None and getattr(meta, "meeting_type", ""):
        mt = meta.get_meeting_type_display()
        bits.append(f"{mt} {meta.meeting_sequence}" if meta.meeting_sequence else mt)
    when = getattr(f, "document_date", None) or (meta.meeting_date if meta is not None else None)
    if when:
        bits.append(f"dated {when.isoformat()}")
    return f"[Document: {', '.join(bits)}]\n" if bits else ""


# A per-file cap alone doesn't bound the total request size once a topic
# has many files - a real, live-hit problem: 10 files at 6000 chars each
# needed ~13,500 tokens for one request, more than Groq's free-tier limit of
# 8000 tokens/minute for openai/gpt-oss-20b. MAX_TOTAL_FILE_CHARS bounds the
# whole request regardless of file count, so it stays within reach of small
# or free-tier models on any provider, not just whichever one prompted this.
MAX_PER_FILE_CHARS = 6000
MAX_TOTAL_FILE_CHARS = 18000


def _format_files(ingested_files, with_topic=False, with_doc_meta=False):
    blocks = []
    omitted = []
    remaining = MAX_TOTAL_FILE_CHARS
    for f in ingested_files:
        text = f.extracted_text.strip()
        if not text:
            continue
        if remaining <= 0:
            omitted.append(f.path)
            continue
        # Cap per-file content so one huge file doesn't eat the whole budget.
        snippet = text[: min(MAX_PER_FILE_CHARS, remaining)]
        remaining -= len(snippet)
        # The path in the "FILE:" header must stay EXACTLY f.path, unmodified -
        # sources_used is matched back against this same bare path in
        # core.views._ask_topic/_ask_global (`by_path = {f.path: f ...}`), so
        # topic attribution goes on its own line instead of into the header,
        # where it would otherwise break that exact-match lookup and silently
        # drop every citation.
        topic_line = f"[Topic: {f.topic.name}]\n" if with_topic else ""
        doc_line = _doc_meta_line(f) if with_doc_meta else ""
        blocks.append(f"--- FILE: {f.path} ---\n{topic_line}{doc_line}{snippet}")
    if omitted:
        blocks.append(
            "--- NOTE: {} more file(s) exist but weren't included in this pass due to size "
            "limits - mention this plainly if it's relevant to the question: {} ---".format(
                len(omitted), ", ".join(omitted)
            )
        )
    return "\n\n".join(blocks) if blocks else "(no readable files ingested yet)"


class MissingApiKeyError(RuntimeError):
    pass


def _via_openrouter(prompt, settings):
    api_key = settings.get("llm_api_key")
    if not api_key:
        raise MissingApiKeyError("No OpenRouter API key set.")
    import httpx

    response = httpx.post(
        f"{settings.get('llm_base_url') or 'https://openrouter.ai/api/v1'}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": settings.get("llm_model") or "openai/gpt-5.4",
            "messages": [{"role": "user", "content": prompt}],
            "tools": [SUBMIT_BRIEF_TOOL_OPENAI],
            "tool_choice": {"type": "function", "function": {"name": "submit_orientme_brief"}},
        },
        timeout=120,
    )
    response.raise_for_status()
    data = response.json()
    tool_calls = data["choices"][0]["message"].get("tool_calls") or []
    if not tool_calls:
        raise RuntimeError("Model did not return a brief via tool use.")
    return json.loads(tool_calls[0]["function"]["arguments"])


def call_structured(prompt, tool_name, description, parameters, settings, timeout=120):
    """One schema-constrained call to the app's configured API model (the same
    OpenRouter-compatible endpoint, key and model the brief uses) via a forced
    tool call. Returns the parsed arguments dict. Raises MissingApiKeyError
    when no key is configured and any httpx/parsing error on failure - callers
    decide how to degrade. The key is only ever sent in the Authorization
    header; it is never logged or put in an error message."""
    api_key = settings.get("llm_api_key")
    if not api_key:
        raise MissingApiKeyError("No API key configured.")
    import httpx

    tool = {
        "type": "function",
        "function": {"name": tool_name, "description": description, "parameters": parameters},
    }
    response = httpx.post(
        f"{settings.get('llm_base_url') or 'https://openrouter.ai/api/v1'}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": settings.get("llm_model") or "openai/gpt-5.4",
            "messages": [{"role": "user", "content": prompt}],
            "tools": [tool],
            "tool_choice": {"type": "function", "function": {"name": tool_name}},
        },
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    tool_calls = data["choices"][0]["message"].get("tool_calls") or []
    if not tool_calls:
        raise RuntimeError("Model did not return a result via tool use.")
    return json.loads(tool_calls[0]["function"]["arguments"])


# Meeting classification + title/date/time/attendees/agenda/achieved/hours
# all moved to pure-Python (extraction.py's looks_like_meeting_transcript +
# extract_meeting_metadata/extract_employee_hours) - "less LLM, more
# automation and code-based operation" (Ayush, 24 Sep). Those fields are all
# reliably regex-extractable and the classification gate is what caught a
# real false positive earlier ("Meeting Diarizer" security review) purely
# from a genuine transcript signal (speaker lines / an Attendees: header),
# no model judgment needed. The one thing regex genuinely can't do is pull
# structured action items out of free-flowing meeting speech - that's the
# one LLM call left here, and it only ever runs for files the deterministic
# gate already confirmed look like a real meeting, asking for action items
# alone (a much smaller prompt than the old full classify+extract call).
EXTRACT_ACTION_ITEMS_TOOL_OPENAI = {
    "type": "function",
    "function": {
        "name": "submit_action_items",
        "description": "Report the concrete action items/commitments people agreed to do in this meeting text.",
        "parameters": {
            "type": "object",
            "properties": {
                "action_items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {
                                "type": "string",
                                "description": "A short, concrete description of the task or commitment (who does what).",
                            },
                            "assignee": {
                                "type": "string",
                                "description": "Who it was assigned to, exactly as named in the text. Empty string if unclear.",
                            },
                            "due_date": {
                                "type": "string",
                                "description": (
                                    "Due date as YYYY-MM-DD if stated or clearly implied. Resolve relative "
                                    "wording ('today', 'by tomorrow') against this meeting's own date, given "
                                    "below. Empty string if there's no real due date."
                                ),
                            },
                        },
                        "required": ["title"],
                    },
                    "description": (
                        "Concrete action items, commitments, or next steps someone agreed to do. Empty "
                        "list if none were actually stated - never invent a task that wasn't discussed."
                    ),
                },
            },
            "required": ["action_items"],
        },
    },
}

ACTION_ITEMS_PROMPT_TEMPLATE = """You are extracting action items from ONE meeting's text for OrientMe. \
This document has already been confirmed to be a real meeting record - your only job is to pull out \
concrete action items / commitments / next steps someone agreed to do. Never invent one that isn't \
genuinely present in the text.

This meeting's own date is: {meeting_date}
Resolve relative due-date wording ("today", "by tomorrow") against that date.

Document text:
{text}

Call submit_action_items with your findings."""


def extract_action_items_llm(text, meeting_date, settings):
    """The one remaining LLM call in meeting extraction - everything else
    (is-it-a-meeting, title, date, attendees, agenda, achieved, hours) is
    now pure-Python (see core/extraction.py), called before this ever runs.
    Raises (MissingApiKeyError or any httpx/parsing error) on failure - the
    caller (core/views.py's _extract_and_store) treats action items as a
    bonus, never fatal to storing the rest of a file's metadata."""
    api_key = settings.get("llm_api_key")
    if not api_key:
        raise MissingApiKeyError("No OpenRouter API key set.")
    import httpx

    prompt = ACTION_ITEMS_PROMPT_TEMPLATE.format(
        meeting_date=meeting_date.isoformat() if meeting_date else "(unknown)",
        text=text[:8000],
    )
    response = httpx.post(
        f"{settings.get('llm_base_url') or 'https://openrouter.ai/api/v1'}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": settings.get("llm_model") or "openai/gpt-5.4",
            "messages": [{"role": "user", "content": prompt}],
            "tools": [EXTRACT_ACTION_ITEMS_TOOL_OPENAI],
            "tool_choice": {"type": "function", "function": {"name": "submit_action_items"}},
        },
        timeout=120,
    )
    response.raise_for_status()
    data = response.json()
    tool_calls = data["choices"][0]["message"].get("tool_calls") or []
    if not tool_calls:
        raise RuntimeError("Model did not return action items via tool use.")
    return json.loads(tool_calls[0]["function"]["arguments"]).get("action_items") or []


def _render_plain(brief_fields):
    """Renders the structured tool-call result as readable text for the chat
    message - both the real LLM path and the no-key fallback produce this
    same shape, so the frontend only ever needs to render one format.
    Follows the General Research report's 8-part brief order (why now,
    current state, history, customer thoughts, promises made, next step,
    risks, top links) - why_now was previously captured by the LLM but
    never actually rendered here, a real gap fixed alongside adding the
    still-missing customer_thoughts/promises_made/next_step sections.

    is_conversational short-circuits all of that: a greeting or small talk
    doesn't need a brief, just a normal reply - and this is enforced here
    structurally (not just by asking nicely in the prompt), since a model
    that gets "leave it empty" wrong tends to write "n/a" into every
    section instead of skipping them, which is exactly what this exists to
    prevent."""
    if brief_fields.get("is_conversational"):
        return brief_fields.get("answer_summary") or "Hi! Ask me anything about this project."

    # Same section set/order as views.py's _BRIEF_SECTION_LABELS - kept as a
    # loop (not one if-per-field) so a new section only needs adding here
    # once, not copy-pasted as another if-block.
    SECTION_LABELS = [
        ("why_now", "Why now"),
        ("current_state", "Current Position"),
        ("history", "History"),
        ("customer_thoughts", "What the customer thinks"),
        ("customer_need", "Customer need"),
        ("proposed_solution", "Proposed solution"),
        ("latest_updates", "Latest updates"),
        ("decisions_made", "Decisions made"),
        ("meeting_prep", "Meeting prep"),
        ("promises_made", "Promises made"),
        ("next_step", "Next step"),
        ("risks_and_gaps", "Risks & gaps"),
    ]
    parts = []
    if brief_fields.get("answer_summary"):
        parts.append(brief_fields["answer_summary"])
    for key, label in SECTION_LABELS:
        if brief_fields.get(key):
            parts.append(f"**{label}:** {brief_fields[key]}")
    if brief_fields.get("gaps_no_source_found"):
        parts.append(f"**Not covered by ingested files:** {brief_fields['gaps_no_source_found']}")
    return "\n\n".join(parts)


def generate_brief(topic, question, ingested_files, settings=None):
    """Returns (answer_text, sources_used, is_llm, message, fields).
    is_llm=False means no LLM call happened - either no key is configured,
    or the call failed - message explains which, never a silent swap.
    fields is the raw submit_orientme_brief dict when (and only when) a
    real LLM brief was actually generated - None for small talk, the no-key
    fallback, and a failed call - so a caller that wants to persist the
    structured brief (see core.views._ask_topic's CaseSummary write) can
    tell a genuine brief apart from a plain status message without
    re-parsing the rendered text.

    topic=None is the "common chatbox" case (core.views._ask_global): the
    answer is grounded across every ingested file in every topic at once,
    rather than one topic's own files - each file block is labeled with
    which topic it came from so the model (and the citations it returns)
    can still attribute claims correctly."""
    if settings is None:
        settings = {}

    if _SMALLTALK_RE.match(question.strip()):
        return _smalltalk_reply(question), [], True, None, None

    files_with_text = [f for f in ingested_files if f.extracted_text.strip()]
    scope_phrase = "anywhere" if topic is None else "for this topic"

    if not settings.get("llm_api_key"):
        if not files_with_text:
            return (
                f"No files have been ingested {scope_phrase} yet, and no LLM key is configured "
                "(see Settings) - nothing to answer from.",
                [],
                False,
                "No LLM key configured yet - showing a plain status message instead of a summary.",
                None,
            )
        listing = "\n".join(f"- {f.path}" for f in files_with_text)
        return (
            f"No LLM key is configured yet (see Settings), so this is the raw file list instead "
            f"of a real summary:\n\n{listing}",
            [f.path for f in files_with_text],
            False,
            "No LLM key configured yet (see Settings) - showed the raw ingested file list instead.",
            None,
        )

    manual_state_block = ""
    project_state = getattr(topic, "state", None) if topic else None
    if project_state and (project_state.current_position or "").strip():
        manual_state_block = MANUAL_STATE_BLOCK_TEMPLATE.format(
            updated_at=project_state.updated_at.strftime("%d %b %Y"),
            current_position=project_state.current_position.strip(),
        )

    prompt = PROMPT_TEMPLATE.format(
        topic_name=topic.name if topic else "All projects",
        topic_type=(
            topic.get_topic_type_display()
            if topic
            else "everything OrientMe has ingested, across every project"
        ),
        manual_state_block=manual_state_block,
        manual_notes_block=_build_notes_block(topic),
        sales_recap_block=_build_sales_recap_block(topic),
        question=question,
        files_block=_format_files(
            files_with_text,
            with_topic=topic is None,
            with_doc_meta=bool(topic is not None and topic.topic_type in SALES_TOPIC_TYPES),
        ),
    )
    try:
        fields = _via_openrouter(prompt, settings)
        sources = [] if fields.get("is_conversational") else fields.get("sources_used", [])
        return _render_plain(fields), sources, True, None, fields
    except Exception as exc:  # noqa: BLE001 - never let an LLM hiccup block answering
        listing = "\n".join(f"- {f.path}" for f in files_with_text) or "(no files ingested yet)"
        return (
            f"LLM generation failed ({exc}) - here's the raw file list instead:\n\n{listing}",
            [f.path for f in files_with_text],
            False,
            f"LLM generation failed ({exc}) - showed the raw ingested file list instead.",
            None,
        )


DRAFT_TASK_TOOL_OPENAI = {
    "type": "function",
    "function": {
        "name": "submit_task_draft",
        "description": (
            "Submit a ready-to-use draft for this task - a short status-update email, an agenda "
            "line, a metric update, or whatever format the task's own wording actually calls for."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "draft": {
                    "type": "string",
                    "description": (
                        "The finished draft text, ready to copy and use as-is - no preamble like "
                        "'Here is a draft', just the text itself."
                    ),
                },
            },
            "required": ["draft"],
        },
    },
}

TASK_DRAFT_PROMPT = """You are drafting a ready-to-use piece of text for one task/commitment tracked \
in OrientMe, so a person can review, lightly edit, and use it directly - never invent facts beyond \
what's given below.

Task: {title}
Assignee: {assignee}
Due date: {due_date}
Topic: {topic_name}

Decide the format this task's own wording calls for (a short status-update email, an agenda line, a \
one-line metric update, or a plain note) and write ONLY that - no preamble, no "Here is a draft:".

Call submit_task_draft with the finished text."""


# The Transcripts detail page's "Generate Summary" used to be an LLM call
# here (a submit_meeting_summary tool + prompt, in the same shape as
# generate_task_draft above). Removed and rebuilt as pure code instead -
# see extraction.build_meeting_summary and recordings.generate_summary_
# for_event - per an explicit correction (29 Sep): "you are using too much
# llm... focus on codded thing rather than using llm - llm is for tuff
# works which is imposible to code." A per-recording summary is well
# within reach of deterministic extraction (structured Agenda/Achieved
# headers when a transcript actually has them, frequency-based extractive
# highlights when it doesn't, real already-extracted Task rows for action
# items) - it never needed a live model call at all.


def generate_task_draft(task, settings=None):
    """The Action Center's 'AI Execute': returns (draft_text, is_llm,
    message) for one Task - a ready-to-edit draft instead of writing it
    from scratch. Same no-key/failure-never-blocks rule as generate_brief;
    never sends anything itself (no email, no write to an external system)
    - it only ever returns text for a person to review and copy."""
    if settings is None:
        settings = {}
    if not settings.get("llm_api_key"):
        return (
            f'No LLM key configured yet (see Settings) - draft this yourself for now: "{task.title}"',
            False,
            "No LLM key configured yet (see Settings).",
        )
    import httpx

    prompt = TASK_DRAFT_PROMPT.format(
        title=task.title,
        assignee=task.assignee or "(unassigned)",
        due_date=task.due_date.isoformat() if task.due_date else "(none)",
        topic_name=task.topic.name,
    )
    try:
        response = httpx.post(
            f"{settings.get('llm_base_url') or 'https://openrouter.ai/api/v1'}/chat/completions",
            headers={"Authorization": f"Bearer {settings['llm_api_key']}", "Content-Type": "application/json"},
            json={
                "model": settings.get("llm_model") or "openai/gpt-5.4",
                "messages": [{"role": "user", "content": prompt}],
                "tools": [DRAFT_TASK_TOOL_OPENAI],
                "tool_choice": {"type": "function", "function": {"name": "submit_task_draft"}},
            },
            timeout=120,
        )
        response.raise_for_status()
        data = response.json()
        tool_calls = data["choices"][0]["message"].get("tool_calls") or []
        if not tool_calls:
            raise RuntimeError("Model did not return a draft via tool use.")
        draft = json.loads(tool_calls[0]["function"]["arguments"]).get("draft", "")
        return draft, True, None
    except Exception as exc:  # noqa: BLE001 - never let an LLM hiccup block the action
        return f"Draft generation failed ({exc}).", False, f"Draft generation failed ({exc})."
