"""Where an action item came from (Ayush, 8 Oct 2026: "when I click that it
just will show where did it get that - which transcript or file").

An action item is stored with the file it was pulled from (Task.source_file)
but not with the exact words, because the LLM rewrites them into a short task.
This finds the passage of that file that most closely matches the task - pure
Python, no model, no network - so the source can be shown next to the task.

It is honest about uncertainty: it returns None when nothing in the file
overlaps the task well enough, and the caller then shows only the file, never
a passage it cannot stand behind.
"""

import re
from difflib import SequenceMatcher

from . import extraction

# A passage must share at least this share of the task's own words to be shown.
MIN_MATCH = 0.34
MAX_PASSAGE_CHARS = 420
MAX_CONTEXT_CHARS = 180

_WORD_RE = re.compile(r"[a-z0-9']+")
_TIMED_LINE_RE = re.compile(r"^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$")
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
_STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "from", "have", "will", "would", "should", "could", "about",
    "into", "their", "there", "they", "them", "then", "than", "what", "when", "which", "while", "your", "you",
    "are", "was", "were", "been", "being", "has", "had", "does", "did", "not", "but", "can", "also", "just",
    "need", "needs", "get", "make", "send", "share", "confirm", "check", "review", "update", "follow",
}


def _words(text):
    return {w for w in _WORD_RE.findall((text or "").lower()) if len(w) > 2 and w not in _STOPWORDS}


def _units(text):
    """The candidate passages of a file: a Teams-format transcript's speaker
    turns, otherwise its lines (timestamps kept) split into sentences."""
    turns = extraction.parse_speaker_turns(text)
    if turns:
        return [{"text": t["text"], "speaker": t.get("speaker", ""), "ts": t.get("ts", "")} for t in turns if t.get("text")]
    units = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _TIMED_LINE_RE.match(line)
        ts, body = (m.group(1), m.group(2)) if m else ("", line)
        for part in _SENTENCE_RE.split(body) if len(body) > 300 else [body]:
            if part.strip():
                units.append({"text": part.strip(), "speaker": "", "ts": ts})
    return units


def _clip(text, limit):
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:-") + "…"


def find_supporting_passage(text, title):
    """The passage of `text` that best matches the task `title`, or None.

    Returns {"text", "speaker", "ts", "before", "after", "score"}: the best
    passage, who said it and when (when the file has speaker turns or
    timestamps), a little context either side, and a 0-1 match score."""
    title_words = _words(title)
    if len(title_words) < 2:
        return None
    units = _units(text)
    best_index, best_score = None, 0.0
    for i, unit in enumerate(units):
        unit_words = _words(unit["text"])
        if len(unit_words) < 2:
            continue
        overlap = len(title_words & unit_words) / len(title_words)
        if overlap < MIN_MATCH:
            continue
        # The ratio only breaks ties between passages that share equally many words.
        score = overlap + 0.05 * SequenceMatcher(None, title.lower(), unit["text"].lower()[:300]).ratio()
        if score > best_score:
            best_index, best_score = i, score
    if best_index is None:
        return None
    unit = units[best_index]
    before = units[best_index - 1]["text"] if best_index > 0 else ""
    after = units[best_index + 1]["text"] if best_index + 1 < len(units) else ""
    return {
        "text": _clip(unit["text"], MAX_PASSAGE_CHARS),
        "speaker": unit["speaker"],
        "ts": unit["ts"],
        "before": _clip(before, MAX_CONTEXT_CHARS),
        "after": _clip(after, MAX_CONTEXT_CHARS),
        "score": round(min(best_score, 1.0), 2),
    }
