"""Deterministic (no LLM) detection and application of chat-driven data
corrections - "remove Rinky", "rename Ayush A to Ayush Sinha" - the PRD's own
Should-have "allow durable corrections through chat" item, built the same
way this codebase's other classification-adjacent decisions are: plain
Python pattern matching, not a forced LLM tool call, for the same reason
llm_brief._SMALLTALK_RE exists - a model asked to classify freeform text via
a forced tool call is a real, previously-hit reliability trap for exactly
this kind of "is this a command or a question" decision (see llm_brief.py's
own docstring/comments for the live-tested example).

Both action functions here mutate ExtractedMeta.attendees across every file
in one topic and return a short, honest report of what actually changed -
never a silent no-op, and never inventing a match that isn't a genuinely
close one.
"""

import difflib
import re

from .models import ExtractedMeta

REMOVE_PERSON_RE = re.compile(
    r"^(?:please\s+)?(?:remove|delete)\s+(.+?)"
    r"(?:\s+from\s+(?:the\s+)?(?:attendees|stakeholders|meetings?|list))?[.!\s]*$",
    re.IGNORECASE,
)

RENAME_PERSON_RE = re.compile(
    r"^(?:please\s+)?rename\s+(.+?)\s+to\s+(.+?)[.!\s]*$",
    re.IGNORECASE,
)

# A close-enough match tolerance for typos in a spoken/typed name ("rinki"
# vs the stored "Rinky") - loose enough to forgive a letter or two, tight
# enough that it won't casually match an unrelated name.
FUZZY_CUTOFF = 0.72


def detect_correction(question):
    """Returns {"action": "rename_attendee", "old": ..., "new": ...} or
    {"action": "remove_attendee", "name": ...}, or None if this doesn't look
    like a correction command at all - checked BEFORE any LLM call, same
    place/reason llm_brief._SMALLTALK_RE is."""
    q = question.strip()
    m = RENAME_PERSON_RE.match(q)
    if m:
        return {"action": "rename_attendee", "old": m.group(1).strip(), "new": m.group(2).strip()}
    m = REMOVE_PERSON_RE.match(q)
    if m:
        return {"action": "remove_attendee", "name": m.group(1).strip()}
    return None


def _topic_attendee_metas(topic):
    return list(ExtractedMeta.objects.filter(ingested_file__topic=topic).exclude(attendees=[]))


def _resolve_name(target, metas):
    """Finds the real stored spelling closest to `target` across every
    meeting's attendee list in this topic - exact case-insensitive match
    first, then a fuzzy match so a typo ("rinki") still finds the real
    entry ("Rinky") instead of silently doing nothing."""
    all_names = set()
    for m in metas:
        all_names.update(m.attendees or [])
    if not all_names:
        return None
    lowered = {n.lower(): n for n in all_names}
    if target.lower() in lowered:
        return lowered[target.lower()]
    close = difflib.get_close_matches(target.lower(), lowered.keys(), n=1, cutoff=FUZZY_CUTOFF)
    return lowered[close[0]] if close else None


def apply_removal(topic, name):
    """Removes `name` (fuzzy-matched) from every meeting's attendee list in
    this topic. Returns (message, changed: bool)."""
    metas = _topic_attendee_metas(topic)
    resolved = _resolve_name(name, metas)
    if not resolved:
        return (
            f'Couldn\'t find "{name}" in this topic\'s attendees or stakeholders — nothing removed.',
            False,
        )
    updated = 0
    for m in metas:
        if resolved in (m.attendees or []):
            m.attendees = [a for a in m.attendees if a != resolved]
            m.save(update_fields=["attendees"])
            updated += 1
    return (
        f'Removed "{resolved}" from {updated} meeting{"s" if updated != 1 else ""} in this topic. '
        "It won't show up in Key Stakeholders or Meeting Info anymore.",
        True,
    )


def apply_rename(topic, old, new):
    """Renames `old` (fuzzy-matched) to `new` (used verbatim) across every
    meeting's attendee list in this topic - the PRD's own "persist mappings
    between spelling variants" idea, applied directly rather than a
    confirm-first flow, since chat itself IS the confirmation here."""
    metas = _topic_attendee_metas(topic)
    resolved = _resolve_name(old, metas)
    if not resolved:
        return (
            f'Couldn\'t find "{old}" in this topic\'s attendees or stakeholders — nothing renamed.',
            False,
        )
    updated = 0
    for m in metas:
        if resolved in (m.attendees or []):
            # De-duplicate rather than just substitute - a list that
            # already has both the old and new spelling (two people
            # separately extracted as "Ayush" and "Ayush Sinha A" in the
            # same meeting) would otherwise end up with "new" listed twice.
            renamed = [new if a == resolved else a for a in m.attendees]
            seen = set()
            deduped = [a for a in renamed if not (a in seen or seen.add(a))]
            m.attendees = deduped
            m.save(update_fields=["attendees"])
            updated += 1
    return (
        f'Renamed "{resolved}" to "{new}" in {updated} meeting{"s" if updated != 1 else ""} in this topic.',
        True,
    )
