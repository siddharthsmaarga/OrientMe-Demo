"""Pure-Python heuristic extraction of meeting metadata and employee hours
out of already-ingested text - NO LLM calls, NO network access, stdlib
(re, datetime) only. This exists because the person directing this project
was explicit: "currently I cannot give you any LLM, use your own logic and
Python skills" for this piece of work. Both functions here are pure
(text in, structured data out) and deterministic, so they're trivially
unit-testable and safe to call offline, repeatedly, on any ingested file.
"""

import difflib
import re
from datetime import datetime

MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec"

# A line that is ONLY "Name<whitespace>M:SS/MM:SS/H:MM:SS" and nothing else -
# this is the real shape of a Maarga meeting transcript's per-speaker line
# (e.g. "Venkatesh Krishnamoorthy   1:13" or "Gokul AP   43:24"), so anchoring
# on it per-line is a much more reliable attendee signal than trying to parse
# free-text prose.
#
# Each name word uses `[a-zA-Z.]*` (zero-or-more), not `+` (one-or-more) -
# real transcripts here often end a name with a bare single-letter initial
# (e.g. "Ayush Sinha A"), and `+` required at least 2 characters per word,
# so it silently failed to match a whole real transcript's attendee lines
# and every downstream signal (calendar date, meeting detection, tasks)
# quietly came up empty - confirmed against a real 86-file bulk ingest
# where not one of several genuine transcripts registered as a meeting.
ATTENDEE_LINE_RE = re.compile(
    r"^([A-Z][a-zA-Z.]*(?:\s+[A-Z][a-zA-Z.]*){1,4})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$",
    re.MULTILINE,
)

ATTENDEES_HEADER_RE = re.compile(r"^\s*Attendees\s*[:\-]\s*(.+)$", re.IGNORECASE | re.MULTILINE)

TITLE_HEADER_RE = re.compile(r"^\s*(?:Subject|Title|Meeting)\s*[:\-]\s*(.+)$", re.IGNORECASE | re.MULTILINE)

AGENDA_HEADER_RE = re.compile(r"^\s*(?:Agenda|Target|Goal|Objective)\s*[:\-]\s*(.+)$", re.IGNORECASE | re.MULTILINE)

ACHIEVED_HEADER_RE = re.compile(
    r"^\s*(?:Achieved|Completed|Result|Status|Outcome)\s*[:\-]\s*(.+)$", re.IGNORECASE | re.MULTILINE
)

DATE_PATTERNS = [
    (re.compile(r"\d{4}-\d{2}-\d{2}"), ["%Y-%m-%d"]),
    (re.compile(rf"\d{{1,2}}\s+(?:{MONTHS})[a-z]*\s+\d{{4}}", re.IGNORECASE), ["%d %b %Y", "%d %B %Y"]),
    # US-style "Month DD, YYYY" (e.g. "July 10, 2026") - the format Teams
    # itself writes right under a recording's own title line.
    (
        re.compile(rf"(?:{MONTHS})[a-z]*\s+\d{{1,2}},?\s+\d{{4}}", re.IGNORECASE),
        ["%b %d, %Y", "%B %d, %Y", "%b %d %Y", "%B %d %Y"],
    ),
    (re.compile(r"\d{1,2}/\d{1,2}/\d{2,4}"), ["%d/%m/%Y", "%m/%d/%Y", "%d/%m/%y", "%m/%d/%y"]),
    # Compact "YYYYMMDD" with no separators - the format Teams/Zoom bake into
    # auto-generated recording filenames (e.g.
    # "S. Kothandaramar-20260710_040005UTC-Meeting Recording"), which then
    # gets echoed as the transcript's own first line. Month/day are range-
    # checked directly in the pattern (01-12 / 01-31) so an arbitrary 8-digit
    # number elsewhere in the text isn't mistaken for a date.
    (re.compile(r"20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])"), ["%Y%m%d"]),
]

MEETING_TIME_RE = re.compile(r"\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)")

# Employee-hours lines like "Ravi Kumar: 42 hours" or "Priya Singh - 38.5 hrs" -
# name, then a colon/dash, then a number, then an hours-unit word.
EMPLOYEE_HOURS_RE = re.compile(
    r"^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})\s*[:\-]\s*(\d+(?:\.\d+)?)\s*(?:hours|hrs|h)\b",
    re.MULTILINE | re.IGNORECASE,
)


# Placeholder values a header can carry instead of real names - e.g. the
# synthetic "Attendees: Not captured (auto-transcribed; no speaker
# diarization)" line ingestion writes for a Whisper transcript. These must
# never become an attendee/stakeholder.
_PLACEHOLDER_ATTENDEE_RE = re.compile(
    r"not\s+captured|no\s+speaker\s+diarization|did\s+not\s+report\s+speakers|^\(?\s*(?:unknown|n/?a|none|tbd)\s*\)?$",
    re.IGNORECASE,
)


def is_placeholder_attendee(name):
    return bool(_PLACEHOLDER_ATTENDEE_RE.search((name or "").strip()))


def clean_attendees(names):
    """Read-time filter: drops placeholder entries (see above) that older rows
    may already hold, without rewriting any stored data."""
    return [n for n in (names or []) if isinstance(n, str) and n.strip() and not is_placeholder_attendee(n)]


def _clean_attendee_name(raw):
    """Strip a stray dialogue fragment glued onto the front of a captured
    name - a real-world artifact where the source transcript's blank line
    between speaker turns gets dropped during file conversion, so the tail
    of the PREVIOUS utterance ends up on the same line as the next speaker's
    name+timestamp (e.g. "Okay. Vijay Krishna Ramachandran   10:16:03", where
    "Okay." was really the end of someone else's sentence).

    A leading token is treated as stray dialogue - and discarded, along with
    everything before it - when it ends in one or more periods and is NOT a
    single-letter initial (a real initial like "S." is kept, matching this
    module's own "Ayush Sinha A"-style names). "I." is special-cased as
    almost always the pronoun "I" rather than an initial, since that is the
    single letter transcripts produce this way constantly."""
    tokens = raw.split()
    cut = 0
    for i, tok in enumerate(tokens):
        core = tok.rstrip(".")
        if core != tok and (len(core) != 1 or core == "I"):
            cut = i + 1
    return " ".join(tokens[cut:])


# Teams/Zoom auto-generated recording filenames (e.g.
# "S. Kothandaramar-20260710_040005UTC-Meeting Recording") sometimes get
# echoed as a transcript's own first line, and the heuristic title-picker
# above would otherwise use that raw filename as the meeting title verbatim.
# Strip the machine-generated suffix so the title reads like a title.
_RECORDING_FILENAME_SUFFIX_RE = re.compile(
    r"[-_\s]*\d{8}_\d{6}\s*UTC[-_\s]*(?:Meeting\s*Recording)?\s*$",
    re.IGNORECASE,
)


def looks_like_meeting_transcript(text):
    """True only when the text shows a real meeting signal - a transcript
    speaker line ("Name   M:SS") or an explicit "Attendees:" header - rather
    than just being some arbitrary document. Used to gate the no-LLM
    fallback path so a report/README/random file doesn't get a fabricated
    "meeting title" out of its first line."""
    return bool(ATTENDEE_LINE_RE.search(text) or ATTENDEES_HEADER_RE.search(text))


def _parse_date(match_text):
    for _pattern, formats in DATE_PATTERNS:
        for fmt in formats:
            try:
                return datetime.strptime(match_text, fmt).date()
            except ValueError:
                continue
    return None


def _find_date_in(text):
    for pattern, _formats in DATE_PATTERNS:
        m = pattern.search(text)
        if m:
            d = _parse_date(m.group(0))
            if d:
                return d
    return None


def extract_meeting_metadata(text):
    """Pull meeting_title, meeting_date, meeting_time, attendees, agenda and
    achieved out of one document's text. Returns a plain dict; never raises
    on malformed input - every field just falls back to "" / None / []."""
    text = text or ""

    # Attendees: prefer the real transcript speaker-line format; fall back to
    # a simple "Attendees:" header line if the doc isn't a transcript.
    attendees = []
    seen = set()
    for m in ATTENDEE_LINE_RE.finditer(text):
        name = _clean_attendee_name(m.group(1).strip())
        if name and name not in seen:
            seen.add(name)
            attendees.append(name)
    if not attendees:
        m = ATTENDEES_HEADER_RE.search(text)
        if m:
            # Split on both "," and ";" - an external diarizer joins speakers
            # with "; " (ingestion._extract_via_external_engine).
            for part in re.split(r"[;,]", m.group(1)):
                name = part.strip()
                if name and not is_placeholder_attendee(name) and name not in seen:
                    seen.add(name)
                    attendees.append(name)

    # Title: an explicit header line wins; otherwise the first non-empty
    # line, as long as it isn't itself an attendee/timestamp line and is short.
    meeting_title = ""
    m = TITLE_HEADER_RE.search(text)
    if m:
        meeting_title = m.group(1).strip()
    else:
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if len(stripped) < 120 and not ATTENDEE_LINE_RE.match(stripped):
                cleaned = _RECORDING_FILENAME_SUFFIX_RE.sub("", stripped).strip()
                meeting_title = cleaned or stripped
            break

    meeting_date = _find_date_in(text)

    meeting_time = ""
    m = MEETING_TIME_RE.search(text[:500])
    if m:
        meeting_time = m.group(0)

    agenda = ""
    m = AGENDA_HEADER_RE.search(text)
    if m:
        agenda = m.group(1).strip()

    achieved = ""
    m = ACHIEVED_HEADER_RE.search(text)
    if m:
        achieved = m.group(1).strip()

    return {
        "meeting_title": meeting_title,
        "meeting_date": meeting_date,
        "meeting_time": meeting_time,
        "attendees": attendees,
        "agenda": agenda,
        "achieved": achieved,
    }


_LINE_TIMESTAMP_RE = re.compile(r"^\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*")


# ---------------------------------------------------------------------------
# "Who said what" - speaker turns from Teams-format transcripts (code only).
# A turn starts at a line that is only "Name   H:MM[:SS]" (ATTENDEE_LINE_RE);
# everything up to the next such line is that speaker's text. Text with no
# speaker names (Whisper's "[MM:SS] text" lines) yields no turns: it stays
# unattributed rather than guessed.
# ---------------------------------------------------------------------------
_SYSTEM_LINE_RE = re.compile(
    r"^.{0,80}\b(?:started|stopped|ended)\s+(?:the\s+)?(?:transcription|recording)\.?$", re.IGNORECASE
)
MAX_TURN_CHARS = 8000


def parse_speaker_turns(text):
    """Returns [{"speaker", "ts", "text"}, ...] in transcript order; [] when the
    text has no "Name   H:MM" speaker lines."""
    turns = []
    current = None
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m = ATTENDEE_LINE_RE.match(line)
        if m:
            raw_name = m.group(1).strip()
            name = _clean_attendee_name(raw_name)
            if name and not is_placeholder_attendee(name):
                # A stray tail of the previous utterance glued in front of
                # the name (see _clean_attendee_name) belongs to that turn.
                stray = raw_name[: len(raw_name) - len(name)].strip() if raw_name.endswith(name) else ""
                if stray and current is not None:
                    current["_parts"].append(stray)
                current = {"speaker": name, "ts": m.group(2), "_parts": []}
                turns.append(current)
                continue
        if current is None or _SYSTEM_LINE_RE.match(line):
            continue
        current["_parts"].append(line)
    result = []
    for t in turns:
        body = " ".join(t["_parts"]).strip()
        if len(body) > MAX_TURN_CHARS:
            body = body[:MAX_TURN_CHARS].rstrip() + "..."
        result.append({"speaker": t["speaker"], "ts": t["ts"], "text": body})
    return result


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def substantive_sentences(text, min_words=6):
    """Sentences with enough words to say something (drops "Yeah, I get that.")."""
    out = []
    for sentence in _SENTENCE_SPLIT_RE.split((text or "").strip()):
        sentence = sentence.strip()
        words = _WORD_RE.findall(sentence)
        if len(words) >= min_words:
            out.append(sentence)
    return out


def summarize_speakers(turns, max_lines=3, max_line_chars=200):
    """Per-speaker summary: [{"speaker", "turns", "words", "first_lines": [..3]}],
    busiest speaker first (ties: first to speak)."""
    order = []
    stats = {}
    for t in turns or []:
        name = t.get("speaker") or ""
        if not name:
            continue
        if name not in stats:
            order.append(name)
            stats[name] = {"speaker": name, "turns": 0, "words": 0, "first_lines": []}
        row = stats[name]
        row["turns"] += 1
        body = t.get("text") or ""
        row["words"] += len(body.split())
        if len(row["first_lines"]) < max_lines:
            for sentence in substantive_sentences(body):
                if len(row["first_lines"]) >= max_lines:
                    break
                if len(sentence) > max_line_chars:
                    sentence = sentence[: max_line_chars - 3].rstrip() + "..."
                row["first_lines"].append(sentence)
    return sorted((stats[n] for n in order), key=lambda r: -r["words"])
_WORD_RE = re.compile(r"[a-zA-Z']+")

# Casual spoken-conversation filler that _STOPWORDS (built for formal written
# text) doesn't cover - "sure"/"yeah" etc. are exactly the length-4+ words
# that would otherwise pass the filter below and, precisely because people
# repeat them constantly when talking, would incorrectly score as the most
# "important" words in a transcript. A real, confirmed failure mode: without
# this, a line like "Sure, sure, sure, sure." out-scored substantive lines
# purely by repeating one filler word four times in a row.
_SPOKEN_FILLER_WORDS = {
    "yeah", "sure", "okay", "right", "like", "just", "well", "really",
    "actually", "basically", "kind", "sort", "gonna", "wanna", "hmm", "umm",
    "hello", "thanks", "thank",
    # "you know"/"I mean" - the same failure mode as "sure" above, caught
    # live on a real transcript: "know" alone survived the filter (4+
    # letters, not a formal stopword) and, precisely because "you know" is
    # said constantly, out-scored every substantive line in the meeting.
    "know", "mean",
}


def _score_lines_by_word_frequency(lines):
    """Classic frequency-based extractive scoring (the same family as
    TextRank/Luhn's algorithm) - no LLM, no network, just counting which
    non-stopword words repeat most across the whole text and scoring each
    line by how many DISTINCT such words it contains, normalized by its own
    distinct-word count. Distinct, not raw occurrences, on both sides of
    that ratio - otherwise a line that just repeats one filler word several
    times inflates its own score purely by repetition, without saying
    anything more than a line that used that same word once. This is what
    picks "Highlights" out of a raw transcript with no structured headers -
    a real summarization technique, not a placeholder."""
    word_counts = {}
    line_word_sets = []
    for line in lines:
        words = {
            w.lower()
            for w in _WORD_RE.findall(line)
            if len(w) >= 4 and w.lower() not in _STOPWORDS and w.lower() not in _SPOKEN_FILLER_WORDS
        }
        line_word_sets.append(words)
        for w in words:
            word_counts[w] = word_counts.get(w, 0) + 1

    scored = []
    for words in line_word_sets:
        if not words:
            scored.append(0.0)
            continue
        scored.append(sum(word_counts[w] for w in words) / len(words))
    return scored


def build_meeting_summary(text, action_items=None):
    """Assembles a per-recording summary entirely from deterministic, local
    signals - no LLM call. Reuses extract_meeting_metadata's own regex
    fields (title/date/time/attendees/agenda/achieved - real for a
    structured document like an exported Teams transcript) and, since a
    plain spoken-conversation transcript usually has none of those headers
    at all, falls back to picking out the highest-signal lines via
    frequency-based extractive scoring (see _score_lines_by_word_frequency)
    so a raw Whisper transcript still gets a genuinely useful "Highlights"
    section instead of an empty one. action_items, when given, are real
    Task rows already extracted for this recording (never re-derived here -
    this function only ever reads already-known facts, it doesn't invent
    new ones)."""
    text = text or ""
    meta = extract_meeting_metadata(text)
    parts = []

    header_bits = []
    if meta["meeting_date"]:
        header_bits.append(meta["meeting_date"].strftime("%d %b %Y"))
    if meta["meeting_time"]:
        header_bits.append(meta["meeting_time"])
    if meta["attendees"]:
        header_bits.append("Attendees: " + ", ".join(meta["attendees"]))
    if header_bits:
        parts.append(" · ".join(header_bits))

    if meta["agenda"]:
        parts.append(f"**Agenda:** {meta['agenda']}")
    if meta["achieved"]:
        parts.append(f"**Outcome:** {meta['achieved']}")

    if not meta["agenda"] and not meta["achieved"]:
        body_lines = [
            _LINE_TIMESTAMP_RE.sub("", line).strip()
            for line in text.splitlines()
            if line.strip() and not ATTENDEE_LINE_RE.match(line) and not ATTENDEES_HEADER_RE.match(line)
        ]
        if body_lines:
            scores = _score_lines_by_word_frequency(body_lines)
            top_n = min(5, len(body_lines))
            top_indices = sorted(range(len(body_lines)), key=lambda i: scores[i], reverse=True)[:top_n]
            highlight_lines = [body_lines[i] for i in sorted(top_indices) if scores[i] > 0]
            if highlight_lines:
                parts.append("**Highlights:**\n" + "\n".join(f"- {line}" for line in highlight_lines))

    if action_items:
        parts.append(
            "**Action Items:**\n"
            + "\n".join(
                f"- {item['title']}"
                + (f" — {item['assignee']}" if item.get("assignee") else "")
                + (f" (due {item['due_date']})" if item.get("due_date") else "")
                for item in action_items
            )
        )

    if not parts:
        parts.append(
            "No summarizable content found - this transcript has no structured Agenda/Achieved "
            "headers and no lines with distinctive enough wording to extract highlights from."
        )

    return "\n\n".join(parts)


def extract_employee_hours(text):
    """Pull [{"name", "hours", "date"}, ...] entries out of lines like
    "Ravi Kumar: 42 hours" or "Priya Singh - 38.5 hrs". A date found
    elsewhere on the same matched line is attached; otherwise None."""
    text = text or ""
    results = []
    for line in text.splitlines():
        m = EMPLOYEE_HOURS_RE.match(line.strip())
        if not m:
            continue
        name = m.group(1).strip()
        hours = float(m.group(2))
        date = _find_date_in(line)
        results.append({"name": name, "hours": hours, "date": date.isoformat() if date else None})
    return results


# Common lead-in phrases people type before naming what they actually want to
# be oriented on - stripped (longest first, so a longer phrase wins over a
# shorter one that's a substring of it) when deriving a suggested topic name
# for a request that matched nothing. Case-insensitive; matched against the
# lowercased request text.
_LEAD_IN_PHRASES = sorted(
    [
        "help me prepare for my meeting with",
        "help me prepare for",
        "help me with",
        "prepare me for",
        "tell me about",
        "what's happening with",
        "give me an update on",
        "i want to know about",
        "orient me on",
    ],
    key=len,
    reverse=True,
)


def _suggest_name(request_text):
    lowered = request_text.lower()
    remainder = lowered
    for phrase in _LEAD_IN_PHRASES:
        if remainder.startswith(phrase):
            remainder = remainder[len(phrase):]
            break
    remainder = remainder.strip()
    for prefix in ("my ", "the "):
        if remainder.startswith(prefix):
            remainder = remainder[len(prefix):]
            break
    remainder = remainder.strip()
    if not remainder:
        return request_text[:60].title()
    return remainder[:80].title()


# Typo tolerance for resolve_topic's word scoring - a real gap someone hit
# directly ("what if anyone misspelled the project name"): the scoring loop
# below only ever did an exact substring check, so "orintme" or "projct"
# never matched "orientme"/"project" at all. difflib is stdlib - no new
# dependency, keeps this function's own "no LLM, no network" rule intact.
_FUZZY_WORD_RATIO = 0.82  # ~1-2 character edits on a normal-length word
_FUZZY_MIN_LEN = 4  # below this, short words are too noisy to fuzzy-match


def _fuzzy_word_hit(haystack_word, request_words):
    """True if haystack_word close-matches (typo-tolerant) any individual
    word actually typed in the request. Length-gated both ways so e.g. "is"
    vs "his" doesn't spuriously "fuzzy match" - short words need an exact
    substring hit (already checked by the caller before this runs)."""
    if len(haystack_word) < _FUZZY_MIN_LEN:
        return False
    for rw in request_words:
        if len(rw) < _FUZZY_MIN_LEN:
            continue
        if difflib.SequenceMatcher(None, haystack_word, rw).ratio() >= _FUZZY_WORD_RATIO:
            return True
    return False


# Common English words a real request is full of but that carry zero
# topic-identifying signal - without this, "the"/"what"/"status" etc. score
# as a "match" against literally any topic whose own content happens to
# contain the same everyday word, purely because both are >=3 characters.
# Real bug this caused: a content-rich topic accumulates several of these
# by sheer volume and can out-score a smaller topic's single genuinely
# distinctive word (e.g. its own name) - see resolve_topic's own docstring.
_STOPWORDS = {
    "the", "and", "for", "with", "are", "was", "were", "will", "what", "who",
    "when", "where", "why", "how", "all", "any", "can", "did", "does", "not",
    "should", "would", "could", "this", "that", "from", "have", "has", "had",
    "you", "your", "our", "their", "its", "his", "her", "them", "they", "about",
    "into", "over", "under", "than", "then", "there", "here", "some", "more",
    "most", "such", "each", "both", "just", "also", "get", "got", "give",
}


def resolve_topic(request_text, topics):
    """Pure, DB-free heuristic match of a free-text request to the topic it
    most likely means - the PRD's "resolve the request to the likely work
    context, asking for disambiguation only when necessary" behavior,
    without any LLM or network call. `topics` is whatever iterable of Topic
    instances the caller already has (this function only reads them, never
    queries the DB itself - so prefetch topic.files__meta and topic.tasks
    on the caller's side, or every one of those relations becomes a fresh
    query per topic per request).

    The haystack deliberately stays to short, already-curated signals
    (meeting titles, real attendee names, task titles) rather than each
    file's full raw extracted text - a real black-box test found that
    name-only matching missed obvious content questions ("who attended the
    shared context meeting" returned no_match even though a real meeting
    titled almost exactly that was ingested), but matching against raw
    multi-page transcript text for every topic on every request would be
    both slow and noisy (one stray shared word in a long document
    shouldn't out-vote a real topic-name match).

    A topic's own NAME/one_liner scores at a much higher weight than its
    incidental meeting/task/attendee content - a real, confirmed bug had
    "what is the status of linkedin project" resolve to "Orient-Me" (a
    large, content-rich topic whose own task titles happened to contain
    the generic words "status" and "project") instead of the obviously-
    intended "Linkedin Marketing", because every matching word scored
    identically regardless of source. A topic's name is a deliberate,
    precise identity signal; a word buried in one of many task titles is
    noise that souldn't be able to outvote it just by being more numerous.

    Matching is whole-word (against the tokenized request), not substring
    containment - substring containment let unrelated haystack words match
    purely by accident (e.g. "linked", from some unrelated task title,
    matching because it's a literal substring of "linkedin").

    Typo-tolerant: a haystack word that isn't an exact hit still scores (at
    a lower weight) if it's a close fuzzy match to some word the person
    actually typed - see _fuzzy_word_hit. Catches "orintme"/"projct"-style
    misspellings without needing an LLM call.

    Returns one of:
      {"outcome": "matched", "topic": <Topic>}
      {"outcome": "ambiguous", "topics": [<Topic>, ...]}  (capped at 5)
      {"outcome": "no_match", "suggested_name": "..."}
    """
    topics = list(topics)
    lowered_request = request_text.lower()
    request_words = [w for w in re.split(r"[\s,]+", lowered_request) if w]
    request_word_set = set(request_words)

    def _score_haystack(parts, weight):
        haystack = " ".join(p for p in parts if p).lower()
        words = set(
            w for w in re.split(r"[\s,]+", haystack) if len(w) >= 3 and w not in _STOPWORDS
        )
        score = 0.0
        for w in words:
            if w in request_word_set:
                score += weight
            elif _fuzzy_word_hit(w, request_words):
                score += weight * 0.7
        return score

    scored = []
    for topic in topics:
        # Primary: the topic's own declared identity - weighted far above
        # incidental content so it can't be drowned out by volume.
        primary_score = _score_haystack([topic.name, topic.one_liner], weight=3.0)

        # Secondary: everything else already curated as a real signal
        # (people, meeting titles, task titles) - still useful (it's what
        # makes "who attended the shared context meeting" resolvable) but
        # can't single-handedly outweigh a real name match.
        secondary_parts = [topic.related_people]
        for f in topic.files.all():
            meta = getattr(f, "meta", None)
            if meta is None:
                continue
            secondary_parts.append(meta.meeting_title)
            secondary_parts.extend(meta.attendees or [])
        for t in topic.tasks.all():
            secondary_parts.append(t.title)
        secondary_score = _score_haystack(secondary_parts, weight=1.0)

        scored.append((topic, primary_score + secondary_score))

    max_score = max((score for _topic, score in scored), default=0)

    if max_score == 0:
        # Real nearest-name lookup (whole request vs each topic's real
        # name), not just a cosmetic title-cased echo of the input - so
        # "closest guess" in the no_match response is an honest suggestion,
        # not decoration. Falls back to the old echo when nothing's close.
        topic_names = [t.name for t in topics]
        close = difflib.get_close_matches(request_text, topic_names, n=1, cutoff=0.3) if topic_names else []
        suggested = close[0] if close else _suggest_name(request_text)
        return {"outcome": "no_match", "suggested_name": suggested}

    tied = [topic for topic, score in scored if score == max_score]

    if len(tied) == 1:
        return {"outcome": "matched", "topic": tied[0]}

    return {"outcome": "ambiguous", "topics": tied[:5]}
