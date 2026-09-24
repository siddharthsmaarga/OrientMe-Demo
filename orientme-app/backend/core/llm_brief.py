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
            "Submit the answer. Up to 7 possible sections (why now, current state, history, "
            "what the customer thinks, promises made/waiting-on, next actions, open questions/"
            "risks) plus top links (sources_used) - but this is a MENU, not a fixed template. "
            "Fill in only the sections the actual question calls for; leave the rest as empty "
            "strings. A narrow question gets a narrow answer, not all 7 sections padded out."
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
                "current_state": {"type": "string", "description": "Where things stand today - Venki's own framing: 'what are the recent activities' - based only on the ingested files."},
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
                "promises_made": {
                    "type": "string",
                    "description": "Open commitments made by either side that haven't been closed out yet - Venki's own framing: 'what am I waiting for'. Empty string if none.",
                },
                "promises_made_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths promises_made actually came from.",
                },
                "next_step": {
                    "type": "string",
                    "description": "Venki's own framing: 'what are the next actions'. State the recommended best action AND, where this is an opportunity/commitment-style topic, the minimum acceptable commitment to walk away with (the floor, not just the ideal outcome) - per the PRD's own output contract. Usually one best move - but if there are genuinely 2-3 distinct open next actions (not a sprawling to-do list), name them all rather than picking just one arbitrarily. This is a RECOMMENDATION, not a stated fact.",
                },
                "next_step_sources": {
                    "type": "array", "items": {"type": "string"},
                    "description": "Which file paths the reasoning behind next_step actually came from. Can be empty if next_step is purely a recommendation with no single supporting file.",
                },
                "risks_and_gaps": {"type": "string", "description": "Venki's own framing: 'what are the open questions' - contradictions, stale information, or missing inputs. State plainly if nothing stands out."},
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
  why_now, customer_thoughts, or risks_and_gaps just because you know them - knowing more than \
  was asked is not a reason to say more than was asked. "What's the status and what are the \
  risks" asks for exactly TWO things - fill in current_state and risks_and_gaps, nothing else. \
  Only a genuinely open-ended request ("orient me", "give me the full picture", "catch me up") \
  has no fixed count and may use every section that has real content. A one-thing question that \
  gets a four-or-five-section answer is a mistake every time - re-read the question and cut it \
  down before submitting.
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
- Keep every section factual and concise - this is meant to be read in under a minute. As a concrete \
  target: the sections you DO fill in, combined, should read as roughly 25-30 lines or fewer when \
  rendered - tighten your wording rather than write long paragraphs. This is a target for the sections \
  you choose to fill, not a reason to add sections that weren't asked for.

Scope: {topic_name} ({topic_type})

Question being asked: {question}

Source files available (path, then content):
{files_block}

Call submit_orientme_brief with the finished brief."""


# A per-file cap alone doesn't bound the total request size once a topic
# has many files - a real, live-hit problem: 10 files at 6000 chars each
# needed ~13,500 tokens for one request, more than Groq's free-tier limit of
# 8000 tokens/minute for openai/gpt-oss-20b. MAX_TOTAL_FILE_CHARS bounds the
# whole request regardless of file count, so it stays within reach of small
# or free-tier models on any provider, not just whichever one prompted this.
MAX_PER_FILE_CHARS = 6000
MAX_TOTAL_FILE_CHARS = 18000


def _format_files(ingested_files, with_topic=False):
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
        blocks.append(f"--- FILE: {f.path} ---\n{topic_line}{snippet}")
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


EXTRACT_META_TOOL_OPENAI = {
    "type": "function",
    "function": {
        "name": "submit_document_meeting_metadata",
        "description": (
            "Report whether this document is a meeting record (transcript, minutes, or notes) "
            "and, if so, the structured facts found in it. Never invent a fact that isn't in the text."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "is_meeting": {
                    "type": "boolean",
                    "description": (
                        "True only if this document is actually a meeting transcript, meeting "
                        "minutes, or meeting notes - false for any other kind of document (reports, "
                        "policies, README files, generic notes, etc.). The word 'meeting' appearing "
                        "in the title or filename is NOT itself a signal - e.g. a security review of "
                        "a tool literally named 'Meeting Diarizer' is a REPORT, not a meeting record. "
                        "Judge only from real meeting substance: an actual date/time it was held, "
                        "named attendees, and a discussion/decision narrative - not the word 'meeting' "
                        "appearing anywhere in the text."
                    ),
                },
                "meeting_title": {
                    "type": "string",
                    "description": "The meeting's title or subject. Empty string if not a meeting or not stated.",
                },
                "meeting_date": {
                    "type": "string",
                    "description": (
                        "The meeting's date, formatted as YYYY-MM-DD. Often written explicitly near "
                        "the top (e.g. 'July 10, 2026'), but auto-generated recordings frequently "
                        "embed it as a compact YYYYMMDD run of 8 digits inside the filename-style "
                        "title line instead (e.g. '...-20260710_040005UTC-Meeting Recording' means "
                        "2026-07-10) - check for that pattern too before leaving this empty."
                    ),
                },
                "meeting_time": {
                    "type": "string",
                    "description": "The meeting's start time as stated in the text (e.g. '10:15 AM'), else empty string.",
                },
                "attendees": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Names of people who attended or spoke, exactly as they appear in the text. Empty list if not a meeting.",
                },
                "agenda": {
                    "type": "string",
                    "description": "What the meeting was meant to accomplish / its target, in one or two sentences. Empty string if not stated.",
                },
                "achieved": {
                    "type": "string",
                    "description": "What was actually decided, completed, or achieved, in one or two sentences. Empty string if not stated.",
                },
                "employee_hours": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "hours": {"type": "number"},
                        },
                        "required": ["name", "hours"],
                    },
                    "description": (
                        "Only employees whose worked hours are EXPLICITLY stated in the text (e.g. "
                        "'Ravi Kumar: 42 hours'). Empty list if none are mentioned - never estimate "
                        "or guess hours."
                    ),
                },
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
                                    "wording ('today', 'by tomorrow') against this document's own meeting_date. "
                                    "Empty string if there's no real due date."
                                ),
                            },
                        },
                        "required": ["title"],
                    },
                    "description": (
                        "Concrete action items, commitments, or next steps someone agreed to do - only if "
                        "this document is a meeting record. Empty list if not a meeting, or none were "
                        "actually stated - never invent a task that wasn't discussed."
                    ),
                },
            },
            "required": ["is_meeting"],
        },
    },
}

META_PROMPT_TEMPLATE = """You are extracting structured metadata from ONE document for OrientMe. \
Read the document text below and determine whether it is a meeting transcript, meeting minutes, or \
meeting notes. If it is not a meeting record of any kind (e.g. it's a report, a README, a policy \
document, general notes), set is_meeting to false and leave the other fields empty - do not force \
a meeting interpretation onto a non-meeting document.

If it IS a meeting record, extract only what the text actually states - never invent a title, date, \
attendee, hours figure, or action item that isn't genuinely present. Also pull out any concrete \
action items / commitments / next steps someone agreed to do, resolving relative due dates \
("today", "by tomorrow") against this meeting's own date.

Document text:
{text}

Call submit_document_meeting_metadata with your findings."""


def extract_meeting_metadata_llm(text, settings):
    """LLM-based replacement for extraction.extract_meeting_metadata's blind
    first-line heuristic: asks the model to both judge whether this document
    is actually a meeting record AND, if so, pull the structured facts out of
    it, so a random report/README no longer gets mislabeled as a meeting.
    Raises (MissingApiKeyError or any httpx/parsing error) on failure - the
    caller (core/views.py's _extract_and_store) falls back to the pure-Python
    heuristic when this raises."""
    api_key = settings.get("llm_api_key")
    if not api_key:
        raise MissingApiKeyError("No OpenRouter API key set.")
    import httpx

    prompt = META_PROMPT_TEMPLATE.format(text=text[:8000])
    response = httpx.post(
        f"{settings.get('llm_base_url') or 'https://openrouter.ai/api/v1'}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": settings.get("llm_model") or "openai/gpt-5.4",
            "messages": [{"role": "user", "content": prompt}],
            "tools": [EXTRACT_META_TOOL_OPENAI],
            "tool_choice": {"type": "function", "function": {"name": "submit_document_meeting_metadata"}},
        },
        timeout=120,
    )
    response.raise_for_status()
    data = response.json()
    tool_calls = data["choices"][0]["message"].get("tool_calls") or []
    if not tool_calls:
        raise RuntimeError("Model did not return metadata via tool use.")
    return json.loads(tool_calls[0]["function"]["arguments"])


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

    parts = []
    if brief_fields.get("answer_summary"):
        parts.append(brief_fields["answer_summary"])
    if brief_fields.get("why_now"):
        parts.append(f"**Why now:** {brief_fields['why_now']}")
    if brief_fields.get("current_state"):
        parts.append(f"**Current state:** {brief_fields['current_state']}")
    if brief_fields.get("history"):
        parts.append(f"**History:** {brief_fields['history']}")
    if brief_fields.get("customer_thoughts"):
        parts.append(f"**What the customer thinks:** {brief_fields['customer_thoughts']}")
    if brief_fields.get("promises_made"):
        parts.append(f"**Promises made:** {brief_fields['promises_made']}")
    if brief_fields.get("next_step"):
        parts.append(f"**Next step:** {brief_fields['next_step']}")
    if brief_fields.get("risks_and_gaps"):
        parts.append(f"**Risks & gaps:** {brief_fields['risks_and_gaps']}")
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

    prompt = PROMPT_TEMPLATE.format(
        topic_name=topic.name if topic else "All projects",
        topic_type=(
            topic.get_topic_type_display()
            if topic
            else "everything OrientMe has ingested, across every project"
        ),
        question=question,
        files_block=_format_files(files_with_text, with_topic=topic is None),
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
