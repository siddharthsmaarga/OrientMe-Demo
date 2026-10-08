"""File metadata for OrientMe, following Siddharth's metadata CSV contract
(file, document_type, topic_tags, signal, state, seconds, review_notes) plus
version / document date / meeting type.

Plain Python first: extension + header + filename keywords + content keywords
(no model, no network). Nothing a human has set is ever overwritten (see
apply_auto_metadata / auto_meeting_fields).

One exception, added 8 Oct 2026 on Venki's feedback ("a file may be renamed
to anything"): when the rules cannot be trusted - the type came from a weak
fallback, or from the file NAME alone - refine_doc_type_with_llm reads the
file's CONTENT and decides, so a renamed document still lands in the right
place. It is only ever a refinement of the rule-based answer, it is skipped
when no LLM key is configured, and a person's own choice always wins.

Public entry points
  classify_file(...)            -> dict of auto-detected values (pure function)
  apply_auto_metadata(file)     -> fills IngestedFile fields on a model row
  refine_doc_type_with_llm(...) -> content-based second opinion (LLM, optional)
  detect_meeting_type(*texts)   -> (meeting_type, sequence) from title/filename
  auto_meeting_fields(...)      -> ExtractedMeta fields to merge on (re)build
"""

import hashlib
import logging
import os
import re
import time
from datetime import date
from email.utils import getaddresses, parsedate_to_datetime

from . import extraction

logger = logging.getLogger(__name__)

# Human labels for the CSV "document_type" column (document_type_vocabulary.csv).
# These are also the TEMPLATE NAMES shown in the app: a file is displayed as
# "Opportunity Scorecard" or "Proposal V2", with its real file name second
# (Venki, 8 Oct: "an opportunity might have an opportunity scorecard... that
# should show up as that").
DOC_TYPE_LABELS = {
    "email": "Email",
    "meeting_transcript": "Meeting Transcript",
    "mom_action_items": "MoM / Action Items",
    "proposal": "Proposal",
    "quotation_sow": "Quotation / SOW",
    "prd_brd": "PRD / BRD",
    "project_charter": "Project Charter",
    "project_plan": "Project Plan",
    "stakeholder_map": "Stakeholder Map",
    "opportunity_scorecard": "Opportunity Scorecard",
    "report": "Report",
    "notes": "Notes",
    "other": "Other",
}

# What each type IS - the definitions the content-reading check shows the
# model. One place to extend when a new document type is added.
DOC_TYPE_DEFINITIONS = {
    "email": "An email message or thread (From / To / Subject lines).",
    "meeting_transcript": "A word-for-word record of a meeting or call: people speaking in turns, often with times.",
    "mom_action_items": "Minutes of a meeting: attendees, decisions and a list of action items (a summary, not word-for-word).",
    "proposal": "A document proposing a solution to a customer: approach, scope, timeline.",
    "quotation_sow": "A price quotation or statement of work: scope, prices, payment terms, validity.",
    "prd_brd": "A product or business requirements document: requirements, user stories, acceptance criteria.",
    "project_charter": "A project charter: objectives, scope, team, sponsor, governance.",
    "project_plan": "A plan or schedule of work: milestones, dates, owners, dependencies.",
    "stakeholder_map": "A list or map of people on the customer and Maarga side: names, roles, influence.",
    "opportunity_scorecard": (
        "A scorecard that rates a sales opportunity: criteria with scores, and the current state "
        "compared with the desired state."
    ),
    "report": "A report or analysis presenting findings, figures or status.",
    "notes": "Informal notes or a memo that fits none of the types above.",
    "other": "Does not fit any other type, or cannot be read. Use this whenever unsure.",
}

# Types that mean "a record of a meeting" - when the content check decides a
# file is one of these, the file is also read as a meeting (see views.
# _extract_and_store) so it shows up under Meetings and Action Items.
MEETING_DOC_TYPES = ("meeting_transcript", "mom_action_items")

# How sure the model must be before its answer replaces the rule-based one.
LLM_MIN_CONFIDENCE = 0.75           # the rules had only a weak fallback guess
LLM_OVERRIDE_CONFIDENCE = 0.85      # the rules had a real signal (e.g. the file name)
LLM_MIN_TEXT_CHARS = 60
LLM_TEXT_CHARS = 4500

MEETING_TYPE_LABELS = {
    "intro": "Intro",
    "discovery": "Discovery",
    "solution": "Solution",
    "commercial": "Commercial",
    "kickoff": "Kickoff",
    "review": "Review",
    "standup": "Stand-up",
    "other": "Other",
}

TAG_VOCABULARY = [
    "Relationship", "Requirements", "Solution", "Commercial", "Timeline",
    "Stakeholders", "Risks", "Next Steps", "Decisions",
]
MAX_TAGS = 3
MAX_SIGNAL_CHARS = 200
SCAN_CHARS = 12000  # how much of the text the keyword rules look at


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def _file_names(f):
    """Lower-cased candidate names (display name, path basename) for rules."""
    names = []
    for raw in (getattr(f, "display_name", ""), getattr(f, "path", "")):
        raw = (raw or "").replace("\\", "/")
        base = raw.rsplit("/", 1)[-1]
        if base and base not in names and not raw.startswith(("pasted:", "mbox:", "ics:")):
            names.append(base)
    return names


def primary_filename(f):
    """The best single file name for a file row ("" for pasted/imported items)."""
    names = _file_names(f)
    return names[0] if names else ""


def display_title(f):
    """What to call a file on screen: its template name plus version
    ("Proposal V2", "Opportunity Scorecard"), because that is what the file IS
    even if it was renamed (Venki, 8 Oct). For the catch-all types ("Notes",
    "Other", or not yet typed) the template name says nothing, so the file's
    own name is shown instead."""
    if f is None:
        return ""
    label = DOC_TYPE_LABELS.get(f.doc_type, "")
    if label and f.doc_type not in ("notes", "other"):
        return f"{label} {f.version_label}".strip()
    return primary_filename(f) or f.display_name or label


def _tokens(name):
    stem = os.path.splitext(name)[0]
    stem = re.sub(r"([a-z])([A-Z])", r"\1 \2", stem)  # CamelCase -> words
    return [t for t in re.split(r"[^a-z0-9]+", stem.lower()) if t]


def _headers(text, max_lines=40):
    return "\n".join((text or "").splitlines()[:max_lines])


_EMAIL_FROM_RE = re.compile(r"^\s*From\s*:\s*\S", re.IGNORECASE | re.MULTILINE)
_EMAIL_OTHER_RE = re.compile(r"^\s*(?:To|Subject|Date|Cc)\s*:", re.IGNORECASE | re.MULTILINE)


def looks_like_email(text):
    head = "\n".join(ln for ln in (text or "").splitlines()[:12] if ln.strip())
    return bool(_EMAIL_FROM_RE.search(head) and _EMAIL_OTHER_RE.search(head))


_TIMESTAMP_LINE_RE = re.compile(r"^\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s+\S", re.MULTILINE)


def _strong_transcript_signal(text, names):
    if len(extraction.ATTENDEE_LINE_RE.findall(text or "")) >= 2:
        return True
    if len(_TIMESTAMP_LINE_RE.findall(text or "")) >= 3:
        return True
    for n in names:
        low = n.lower()
        if "meeting recording" in low or "transcript" in low:
            return True
    return False


# ---------------------------------------------------------------------------
# Document type
# ---------------------------------------------------------------------------
_FILENAME_RULES = [
    # (doc_type, token-set, phrases-in-lowercased-name)
    ("mom_action_items", {"minutes", "mom", "momentofmeeting"}, ("action items", "minutes of meeting")),
    ("opportunity_scorecard", {"scorecard", "scorecards"}, ("score card", "opportunity score")),
    ("quotation_sow", {"quotation", "quote", "quotes", "sow", "estimate"}, ("statement of work",)),
    ("prd_brd", {"prd", "brd"}, ("requirements document", "requirement document")),
    ("project_charter", {"charter"}, ()),
    ("stakeholder_map", {"stakeholder", "stakeholders"}, ("stakeholder map",)),
    ("project_plan", {"plan", "roadmap", "workplan"}, ("project plan", "work plan")),
    ("proposal", {"proposal"}, ()),
    ("report", {"report"}, ()),
    ("notes", {"notes", "note"}, ()),
    ("meeting_transcript", {"kickoff", "standup", "sync", "transcript"}, ("kick-off", "stand-up", "kick off", "stand up")),
]

# Content rules look only at the document's title area (its first two
# non-empty lines): a document that merely MENTIONS a quotation or a PRD
# further down is not one.
_CONTENT_RULES = [
    ("opportunity_scorecard", re.compile(r"\bscore\s?card\b", re.I)),
    ("quotation_sow", re.compile(r"\bquotation\b|\bquote\b|statement of work|scope of work|\bsow\b", re.I)),
    ("prd_brd", re.compile(r"product requirements?|business requirements?|requirements? document|\bprd\b|\bbrd\b", re.I)),
    ("project_charter", re.compile(r"project charter", re.I)),
    ("stakeholder_map", re.compile(r"stakeholder (?:map|register|matrix)", re.I)),
    ("project_plan", re.compile(r"project plan|work plan", re.I)),
    ("proposal", re.compile(r"\bproposal\b", re.I)),
]


# How much the rule-based answer can be trusted - the content-reading check
# only runs when it cannot:
#   STRUCTURE  the file's own shape proves it (email headers, speaker lines):
#              never second-guessed.
#   TITLE      the document's own opening lines say what it is: trusted.
#   FILENAME   decided by the file NAME alone: a renamed file defeats this.
#   WEAK       a loose signal or the extension fallback: a guess.
BASIS_STRUCTURE, BASIS_TITLE, BASIS_FILENAME, BASIS_WEAK = "structure", "title", "filename", "weak"


def detect_doc_type_with_basis(text, names, ext, source_method=""):
    """Returns (doc_type, basis). Order: email -> filename-driven MoM ->
    strong transcript signal -> other filename keywords -> content keywords ->
    weak meeting header -> extension fallback. Falls back to "other" (human
    review), never a guess."""
    text = text or ""
    low_names = [n.lower() for n in names]
    toks = set()
    for n in names:
        toks.update(_tokens(n))
        # also the un-split form, so "MoM" is one token ("Mo" + "M" otherwise)
        toks.update(t for t in re.split(r"[^a-z0-9]+", os.path.splitext(n)[0].lower()) if t)

    # 1. Email
    if ext in (".eml", ".msg") or source_method == "email_import" or looks_like_email(text):
        return "email", BASIS_STRUCTURE

    # 2. Filename says MoM (a MoM usually carries an "Attendees:" header too,
    #    so this must beat the transcript content signal).
    mom_rule = _FILENAME_RULES[0]
    if toks & mom_rule[1] or any(p in n for p in mom_rule[2] for n in low_names):
        return "mom_action_items", BASIS_FILENAME

    # 3. Real transcript shape (speaker lines / [MM:SS] lines / Teams name)
    if _strong_transcript_signal(text, names):
        return "meeting_transcript", BASIS_STRUCTURE

    # 4. Other filename keywords
    for doc_type, token_set, phrases in _FILENAME_RULES[1:]:
        if toks & token_set or any(p in n for p in phrases for n in low_names):
            return doc_type, BASIS_FILENAME

    # 5. One "Name   H:MM" speaker line is the app's own definition of a
    #    meeting transcript (extraction.looks_like_meeting_transcript) - tried
    #    after the filename rules so a proposal with a "Kickoff 9:30" agenda
    #    line stays a proposal.
    if extraction.ATTENDEE_LINE_RE.search(text):
        return "meeting_transcript", BASIS_STRUCTURE

    # 6. Content keywords (title area only)
    title_area = "\n".join([ln for ln in text.splitlines() if ln.strip()][:2])[:300]
    for doc_type, pattern in _CONTENT_RULES:
        if pattern.search(title_area):
            return doc_type, BASIS_TITLE

    # 7. Weak meeting signal: an "Attendees:" header
    head = text[:3000]
    if extraction.ATTENDEES_HEADER_RE.search(head):
        weak = "mom_action_items" if re.search(r"action items?|decisions?", text[:SCAN_CHARS], re.I) else "meeting_transcript"
        return weak, BASIS_WEAK

    # 8. Extension / source fallback
    if source_method == "paste" or ext in (".txt", ".md"):
        return "notes", BASIS_WEAK
    return "other", BASIS_WEAK


def detect_doc_type(text, names, ext, source_method=""):
    """The best doc_type key (see detect_doc_type_with_basis for the order)."""
    return detect_doc_type_with_basis(text, names, ext, source_method)[0]


# ---------------------------------------------------------------------------
# Topic tags (up to 3 from the suggested vocabulary)
# ---------------------------------------------------------------------------
_TAG_KEYWORDS = {
    "Relationship": [
        r"introduc\w*", r"nice to meet", r"thanks? for (?:your|the) time", r"catch up", r"touch base",
        r"looking forward", r"reach(?:ed)? out", r"rapport", r"first call",
    ],
    "Requirements": [
        r"requirements?", r"pain points?", r"must[- ]have", r"should be able", r"use cases?",
        r"constraints?", r"we need",
    ],
    "Solution": [
        r"solution", r"propos(?:al|e|ed|ing)", r"architecture", r"pilot", r"\bpoc\b",
    ],
    "Commercial": [
        r"pric(?:e|es|ing)", r"cost\w*", r"budget\w*", r"quot(?:e|ation)", r"invoice", r"payment",
        r"\bfees?\b", r"discount", r"contract", r"commercials?", r"\bsow\b",
    ],
    "Timeline": [
        r"timelines?", r"deadlines?", r"schedule\w*", r"milestones?", r"go[- ]live", r"launch",
        r"phase \d", r"due (?:on|by)", r"by (?:monday|tuesday|wednesday|thursday|friday)",
    ],
    "Stakeholders": [
        r"stakeholders?", r"sponsor", r"decision[- ]makers?", r"approver", r"champion",
        r"org(?:anisation|anization)? chart", r"reports? to", r"head of", r"\bvp\b", r"director",
        r"\bc[ioft]o\b",
    ],
    "Risks": [
        r"risks?", r"concerns?", r"blockers?", r"dependenc(?:y|ies)", r"worried",
        r"uncertain\w*", r"delays?", r"blocked",
    ],
    "Next Steps": [
        r"next steps?", r"action items?", r"follow[- ]?ups?", r"will send", r"to[- ]do", r"next meeting",
        r"let'?s meet", r"schedule a (?:call|meeting)", r"agreed to",
    ],
    "Decisions": [
        r"decided", r"decisions?", r"\bagreed\b", r"approved", r"sign(?:ed)?[- ]off", r"go ahead",
        r"finali[sz]e\w*",
    ],
}
_TAG_PATTERNS = {
    tag: re.compile(r"(?<![a-z0-9])(?:" + "|".join(words) + r")(?![a-z0-9])", re.IGNORECASE)
    for tag, words in _TAG_KEYWORDS.items()
}

# A document type already says something about what it is about.
_DOC_TYPE_TAG_PRIORS = {
    "proposal": {"Solution": 2},
    "quotation_sow": {"Commercial": 2},
    "prd_brd": {"Requirements": 2},
    "project_plan": {"Timeline": 2},
    "project_charter": {"Requirements": 1, "Stakeholders": 1},
    "stakeholder_map": {"Stakeholders": 3},
    "mom_action_items": {"Next Steps": 2},
}
MIN_TAG_SCORE = 3


def suggest_tags(text, doc_type=""):
    scan = (text or "")[:SCAN_CHARS]
    scores = {}
    for tag in TAG_VOCABULARY:
        score = 0
        for m in _TAG_PATTERNS[tag].finditer(scan):
            score += 1
            if score >= 6:
                break
        score += _DOC_TYPE_TAG_PRIORS.get(doc_type, {}).get(tag, 0)
        scores[tag] = score
    ranked = sorted(
        (t for t in TAG_VOCABULARY if scores[t] >= MIN_TAG_SCORE),
        key=lambda t: (-scores[t], TAG_VOCABULARY.index(t)),
    )
    return ranked[:MAX_TAGS]


def normalize_tags(value, limit=MAX_TAGS):
    """Accepts a comma-separated string or a list; returns a clean list of at
    most `limit` unique (case-insensitive) tags, each <= 40 chars. Free text
    is allowed - the vocabulary is only a suggestion. Known vocabulary tags
    are normalised to their canonical casing."""
    if value is None:
        return []
    parts = value if isinstance(value, (list, tuple)) else str(value).split(",")
    canon = {t.lower(): t for t in TAG_VOCABULARY}
    out, seen = [], set()
    for part in parts:
        tag = " ".join(str(part).split())[:40]
        if not tag or tag.lower() in seen:
            continue
        seen.add(tag.lower())
        out.append(canon.get(tag.lower(), tag))
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------------------
# Version label and document date
# ---------------------------------------------------------------------------
_VERSION_RE = re.compile(r"(?<![A-Za-z0-9])v\s?(\d{1,2})(?![A-Za-z0-9])", re.IGNORECASE)
_FINAL_RE = re.compile(r"(?<![A-Za-z0-9])final(?![A-Za-z0-9])", re.IGNORECASE)


def detect_version_label(names):
    """From a filename: "Final" wins, else the highest "v<n>" ("V2"), else ""."""
    best = ""
    for name in names:
        stem = os.path.splitext(name)[0]
        if _FINAL_RE.search(stem):
            return "Final"
        nums = [int(n) for n in _VERSION_RE.findall(stem)]
        if nums and not best:
            best = f"V{max(nums)}"
    return best


_FILENAME_DATE_RE = re.compile(
    r"(?<!\d)(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)"
)
_DATE_LINE_RE = re.compile(r"^\s*Date\s*[:\-]\s*(.+)$", re.IGNORECASE | re.MULTILINE)


def _valid_date(d):
    return d if d and 2000 <= d.year <= 2100 else None


def _parse_header_date(value):
    value = (value or "").strip()
    if not value:
        return None
    try:
        return _valid_date(parsedate_to_datetime(value).date())
    except (TypeError, ValueError, IndexError):
        pass
    return _valid_date(extraction._find_date_in(value))


def detect_document_date(text, names):
    """Email Date header / "Date:" line (first 40 lines), else a date stamp in
    the filename, else None."""
    m = _DATE_LINE_RE.search(_headers(text))
    if m:
        d = _parse_header_date(m.group(1))
        if d:
            return d
    # A transcript's first line often echoes the recording's own name, which
    # carries the stamp (e.g. "...-20260923_045358UTC-Meeting Recording").
    first_line = next((ln for ln in (text or "").splitlines() if ln.strip()), "")
    for name in list(names) + [first_line[:200]]:
        fm = _FILENAME_DATE_RE.search(name)
        if fm:
            try:
                return _valid_date(date(int(fm.group(1)), int(fm.group(2)), int(fm.group(3))))
            except ValueError:
                continue
    return None


# ---------------------------------------------------------------------------
# Signal: one sentence
# ---------------------------------------------------------------------------
_HEADERISH_RE = re.compile(
    r"^\s*(?:attendees?|from|to|cc|bcc|date|subject|title|meeting|time|agenda|target|goal|objective|"
    r"location|sent|reply-to)\s*[:\-]",
    re.IGNORECASE,
)
_QUOTE_BREAK_RE = re.compile(
    r"^\s*(?:-{2,}\s*original message|on .{5,120} wrote:|from:\s.*sent:|>{1})", re.IGNORECASE
)
_GREETING_RE = re.compile(r"^\s*(?:hi|hello|dear|hey|good (?:morning|afternoon|evening))\b[^.!?]{0,60}[,!:]?\s*$", re.I)


def _truncate(text, limit=MAX_SIGNAL_CHARS):
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 3].rsplit(" ", 1)[0].rstrip(" ,;:-")
    return cut + "..."


def first_meaningful_sentence(text, min_words=6):
    """First sentence of real prose. Pass 1 only accepts a sentence that ends
    in . ! or ? (so a title line is skipped); pass 2 accepts any line with
    enough words (spreadsheets, bullet lists)."""
    candidates = []
    for raw in (text or "").splitlines():
        line = extraction._LINE_TIMESTAMP_RE.sub("", raw).strip()
        if not line or _HEADERISH_RE.match(line) or _GREETING_RE.match(line):
            continue
        if extraction.ATTENDEE_LINE_RE.match(line) or line.startswith("---"):
            continue
        candidates.extend(extraction.substantive_sentences(line, min_words=min_words))
    for sentence in candidates:
        if sentence[-1] in ".!?":
            return sentence
    return candidates[0] if candidates else ""


def _email_parts(text):
    """(subject, body) from an ingested email's text (header block, blank line,
    body). Quoted replies / signatures after the first quote marker are cut."""
    subject = ""
    m = re.search(r"^\s*Subject\s*:\s*(.*)$", _headers(text), re.IGNORECASE | re.MULTILINE)
    if m:
        subject = m.group(1).strip()
    body_lines = []
    in_body = False
    for ln in (text or "").splitlines():
        if not in_body:
            if not ln.strip():
                in_body = True
            continue
        if _QUOTE_BREAK_RE.match(ln):
            break
        body_lines.append(ln)
    return subject, "\n".join(body_lines)


def email_subject(text):
    return _email_parts(text)[0]


def build_signal(text, doc_type):
    text = text or ""
    if doc_type == "email":
        subject, body = _email_parts(text)
        sentence = first_meaningful_sentence(body, min_words=5)
        if subject and sentence:
            return _truncate(f"{subject} - {sentence}")
        return _truncate(subject or sentence)
    if doc_type in ("meeting_transcript", "mom_action_items"):
        meta = extraction.extract_meeting_metadata(text)
        for key in ("achieved", "agenda"):
            if meta[key]:
                return _truncate(meta[key])
        turns = extraction.parse_speaker_turns(text)
        if turns:
            # Skip the title/date/duration header lines: speech only.
            return _truncate(first_meaningful_sentence("\n".join(t["text"] for t in turns)))
    return _truncate(first_meaningful_sentence(text))


# ---------------------------------------------------------------------------
# Email participants (for the CSV "participants" column)
# ---------------------------------------------------------------------------
def email_participants(text):
    head = _headers(text, 12)
    values = []
    for key in ("From", "To", "Cc"):
        m = re.search(rf"^\s*{key}\s*:\s*(.*)$", head, re.IGNORECASE | re.MULTILINE)
        if m:
            values.append(m.group(1))
    names = []
    for display, addr in getaddresses(values):
        label = (display or "").strip().strip('"') or (addr or "").split("@")[0]
        if label and label not in names:
            names.append(label)
    return names


# ---------------------------------------------------------------------------
# Pure classification of one file
# ---------------------------------------------------------------------------
def classify_file(text, names, source_method="", has_error=False):
    """Pure function: returns dict(doc_type, topic_tags (list), signal,
    version_label, document_date)."""
    ext = ""
    for n in names:
        e = os.path.splitext(n)[1].lower()
        if e:
            ext = e
            break
    text = "" if has_error else (text or "")
    doc_type = detect_doc_type(text, names, ext, source_method)
    return {
        "doc_type": doc_type,
        "topic_tags": [] if has_error else suggest_tags(text, doc_type),
        "signal": "" if has_error else build_signal(text, doc_type),
        "version_label": detect_version_label(names),
        "document_date": detect_document_date(text, names),
    }


_AUTO_FIELDS = ("topic_tags", "signal", "version_label", "document_date")


def apply_auto_metadata(f, save=True):
    """Fills the metadata fields of an IngestedFile in place (and saves them
    with update_fields, so last_ingested_at is untouched). Never overwrites a
    human's work: a row whose meta_state is "confirmed"/"corrected" is left
    alone entirely, and a manually-set doc_type is kept either way. Returns
    True when anything changed."""
    if f.meta_state in ("confirmed", "corrected"):
        return False
    started = time.perf_counter()
    has_error = bool(f.extraction_error)
    result = classify_file(f.extracted_text, _file_names(f), f.source_method, has_error=has_error)

    # A type the content check decided stays decided for as long as the file's
    # content is unchanged; if the file changes, the rules run again and the
    # content check is asked again.
    keep_llm = (
        f.doc_type_source == "llm" and bool(f.llm_checked_hash) and f.llm_checked_hash == _content_hash(f) and not has_error
    )
    if keep_llm:
        result["topic_tags"] = suggest_tags(f.extracted_text, f.doc_type)
        result["signal"] = build_signal(f.extracted_text, f.doc_type)

    new_values = {
        "topic_tags": ", ".join(result["topic_tags"]),
        "signal": result["signal"],
        "version_label": result["version_label"],
        "document_date": result["document_date"],
        "meta_state": "error" if has_error else "generated_unconfirmed",
    }
    if f.doc_type_source != "manual" and not keep_llm:
        new_values["doc_type"] = result["doc_type"]
        new_values["doc_type_source"] = "auto"

    changed = [k for k, v in new_values.items() if getattr(f, k) != v]
    if not changed:
        return False
    for k in changed:
        setattr(f, k, new_values[k])
    f.meta_seconds = round(time.perf_counter() - started, 3)
    if save:
        f.save(update_fields=list(changed) + ["meta_seconds"])
    return True


def safe_apply_auto_metadata(f):
    """Same, but never raises - classification is a bonus and must not break an ingest."""
    try:
        return apply_auto_metadata(f)
    except Exception:  # noqa: BLE001
        logger.exception("Auto metadata failed for file %s", getattr(f, "id", None))
        return False


# ---------------------------------------------------------------------------
# Content-based second opinion (LLM) - for files whose NAME cannot be trusted
# ---------------------------------------------------------------------------
CLASSIFY_TOOL_NAME = "classify_document"

CLASSIFY_PROMPT_TEMPLATE = """You are classifying ONE document for OrientMe by reading its CONTENT. \
Files are often renamed to something unrelated, so the file name below is only a weak hint - trust what \
the document actually says, not what it is called.

Choose exactly ONE document type from this list:
{types}

If the content does not clearly match one type, choose "other". Never decide from the file name alone.

File name (may be wrong): {name}
Rule-based guess (may be wrong): {guess}

Document text (the start of the file):
{text}

Call {tool} with the type, how sure you are (0 to 1), and one short reason."""


def _classify_tool_schema():
    return {
        "type": "object",
        "properties": {
            "doc_type": {
                "type": "string",
                "enum": list(DOC_TYPE_DEFINITIONS.keys()),
                "description": "The single best document type, judged from the content.",
            },
            "confidence": {"type": "number", "description": "0 to 1: how sure you are."},
            "reason": {"type": "string", "description": "One short sentence: what in the text shows this."},
        },
        "required": ["doc_type", "confidence"],
    }


def build_classify_prompt(text, name, guess):
    types = "\n".join(f'- "{key}": {definition}' for key, definition in DOC_TYPE_DEFINITIONS.items())
    return CLASSIFY_PROMPT_TEMPLATE.format(
        types=types,
        name=name or "(none)",
        guess=guess or "(none)",
        text=(text or "")[:LLM_TEXT_CHARS],
        tool=CLASSIFY_TOOL_NAME,
    )


def _content_hash(f):
    return f.content_hash or hashlib.sha256((f.extracted_text or "").encode("utf-8", "ignore")).hexdigest()


def _rule_basis(f):
    """(doc_type, basis) the rules give this file right now."""
    names = _file_names(f)
    ext = ""
    for n in names:
        e = os.path.splitext(n)[1].lower()
        if e:
            ext = e
            break
    return detect_doc_type_with_basis(f.extracted_text or "", names, ext, f.source_method)


def needs_content_check(f):
    """True when this file's type should be decided by reading its content:
    nothing a person set, not an unreadable/near-empty file, not already
    checked at this exact content, and the rules' answer is not one the
    file's own structure proves (an email's headers, a transcript's speaker
    lines)."""
    if f.doc_type_source == "manual" or f.meta_state in ("confirmed", "corrected"):
        return False
    if f.extraction_error or len((f.extracted_text or "").strip()) < LLM_MIN_TEXT_CHARS:
        return False
    if f.llm_checked_hash and f.llm_checked_hash == _content_hash(f):
        return False
    _, basis = _rule_basis(f)
    return basis != BASIS_STRUCTURE


def decide_from_llm_answer(rule_type, rule_basis, answer):
    """Pure decision: given the rules' answer and the model's, which type wins?
    Returns the winning doc_type, or None to keep the rules' answer. The model
    only replaces a rule answer when it is clearly sure, and needs to be surer
    to overrule something the rules actually had a signal for."""
    llm_type = (answer or {}).get("doc_type")
    if llm_type not in DOC_TYPE_DEFINITIONS or llm_type in ("other", rule_type):
        return None
    try:
        confidence = float((answer or {}).get("confidence"))
    except (TypeError, ValueError):
        return None
    needed = LLM_MIN_CONFIDENCE if (rule_basis == BASIS_WEAK or rule_type in ("notes", "other")) else LLM_OVERRIDE_CONFIDENCE
    return llm_type if confidence >= needed else None


def refine_doc_type_with_llm(f, settings, call=None):
    """Reads the file's CONTENT (not its name) and, when clearly sure, sets its
    document type - so a file renamed to anything still lands in the right
    place. Returns True when the type changed.

    - Only runs when needs_content_check(f) says the rules cannot be trusted.
    - Needs an LLM key in `settings`; without one it does nothing (and does not
      mark the file as checked, so a later run with a key still can).
    - A person's own choice is never touched; the file is marked checked at
      this content hash either way, so an unchanged file is not sent twice.
    `call` is the model caller (defaults to the app's configured one); tests
    pass a stub."""
    if not (settings or {}).get("llm_api_key") or not needs_content_check(f):
        return False
    if call is None:
        from . import llm_brief

        call = llm_brief.call_structured

    rule_type, rule_basis = _rule_basis(f)
    prompt = build_classify_prompt(f.extracted_text, primary_filename(f), DOC_TYPE_LABELS.get(rule_type, rule_type))
    answer = call(
        prompt,
        CLASSIFY_TOOL_NAME,
        "Report the single document type that best matches this document's content.",
        _classify_tool_schema(),
        settings,
        timeout=60,
    )
    winner = decide_from_llm_answer(rule_type, rule_basis, answer)

    update = ["llm_checked_hash"]
    f.llm_checked_hash = _content_hash(f)
    changed = False
    if winner and winner != f.doc_type:
        f.doc_type = winner
        f.doc_type_source = "llm"
        # Tags and the one-line signal lean on the document type, so they are
        # recomputed for the new type (never for a confirmed/corrected file -
        # needs_content_check already excluded those).
        f.topic_tags = ", ".join(suggest_tags(f.extracted_text, winner))
        f.signal = build_signal(f.extracted_text, winner)
        update += ["doc_type", "doc_type_source", "topic_tags", "signal"]
        changed = True
    f.save(update_fields=update)
    return changed


def safe_refine_doc_type_with_llm(f, settings, call=None):
    """Same, but never raises: the content check is a refinement and must
    never break an ingest. (A failed call leaves the rules' answer in place
    and the file unmarked, so it is simply tried again next time.) The
    document text and the API key are never logged."""
    try:
        return refine_doc_type_with_llm(f, settings, call=call)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Content-based classification skipped for file %s (%s)", getattr(f, "id", None), type(exc).__name__)
        return False


# ---------------------------------------------------------------------------
# Meeting type + sequence (title / filename keywords)
# ---------------------------------------------------------------------------
_MEETING_KEYWORDS = [
    # Priority order matters: "solution review" -> solution, not review.
    ("kickoff", r"kick[- ]?off"),
    ("intro", r"intro(?:duction)?s?"),
    ("discovery", r"discovery"),
    ("solution", r"solution(?:s|ing)?"),
    ("commercial", r"commercials?|pricing|negotiation"),
    ("standup", r"stand[- ]?ups?|sync(?:[- ]?up)?|weekly"),
    ("review", r"review"),
]
_FILLER = r"(?:[\W_]+(?:call|meeting|session|workshop|review|demo|sync))?"


def detect_meeting_type(*texts):
    """First text (title, then filename) that carries a type keyword wins.
    Returns (type, sequence-or-None); ("", None) when no keyword is found."""
    for raw in texts:
        raw = (raw or "").strip()
        if not raw:
            continue
        for mtype, kw in _MEETING_KEYWORDS:
            m = re.search(rf"(?<![A-Za-z0-9])(?:{kw})(?![A-Za-z])", raw, re.IGNORECASE)
            if not m:
                continue
            seq = None
            after = re.search(
                rf"(?<![A-Za-z0-9])(?:{kw}){_FILLER}[\W_]{{0,3}}#?\s*(\d{{1,2}})(?!\d)", raw, re.IGNORECASE
            )
            if after:
                seq = int(after.group(1))
            else:
                before = re.search(
                    rf"(?<!\d)(\d{{1,2}})(?:st|nd|rd|th)\s+(?:{kw})(?![A-Za-z])", raw, re.IGNORECASE
                )
                if before:
                    seq = int(before.group(1))
            return mtype, seq
    return "", None


def auto_meeting_fields(title, filename, text, existing=None):
    """ExtractedMeta fields to merge when a meeting row is (re)built from a
    file. A manually-set type/sequence is preserved (nothing returned for
    them); speaker turns are always recomputed from the text (it is the same
    pure function of the same text)."""
    fields = {"speaker_turns": extraction.parse_speaker_turns(text)}
    if existing is not None and existing.meeting_type_source == "manual":
        return fields
    mtype, seq = detect_meeting_type(title, os.path.splitext(filename or "")[0])
    fields["meeting_type"] = mtype
    fields["meeting_sequence"] = seq
    fields["meeting_type_source"] = "auto" if mtype else ""
    return fields


def meeting_display_title(raw_short_title, raw_title, meeting_type, meeting_sequence):
    """Title shown on timelines: "Discovery 2: <title>" when a type is set;
    otherwise exactly the short title it always was."""
    if not meeting_type:
        return raw_short_title
    label = MEETING_TYPE_LABELS.get(meeting_type, meeting_type.title())
    label = f"{label} {meeting_sequence}" if meeting_sequence else label
    title = (raw_title or "").strip()
    if label.lower() in title.lower():
        return title
    return f"{label}: {raw_short_title}" if raw_short_title else label
