"""Pure-stdlib .ics (iCalendar) parsing for the "Calendar export" data-fetch
option - hand-rolled instead of adding the `icalendar` package, since only a
handful of fields (SUMMARY/DTSTART/DESCRIPTION/ATTENDEE/LOCATION) actually
matter here, matching this project's no-new-dependency convention already
used in extraction.py."""

import re
from datetime import datetime


def _unfold_lines(text):
    # RFC 5545 line folding: a continuation line starts with a space or tab.
    lines = text.replace("\r\n", "\n").split("\n")
    unfolded = []
    for line in lines:
        if line.startswith((" ", "\t")) and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)
    return unfolded


def _parse_dt(value):
    value = value.strip()
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y%m%dT%H%M%S", "%Y%m%d"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def _unescape(value):
    return value.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


def parse_ics(text):
    """Returns a list of {"summary", "start", "description", "location",
    "attendees": [...]} dicts, one per VEVENT block. Events with no parsable
    DTSTART are skipped by the caller, not here - this just reports what it
    found."""
    events = []
    current = None
    for raw_line in _unfold_lines(text):
        line = raw_line.strip()
        if line == "BEGIN:VEVENT":
            current = {"summary": "", "start": None, "description": "", "location": "", "attendees": []}
            continue
        if line == "END:VEVENT":
            if current is not None:
                events.append(current)
            current = None
            continue
        if current is None or ":" not in line:
            continue

        key_part, value = line.split(":", 1)
        key = key_part.split(";")[0].upper()
        if key == "SUMMARY":
            current["summary"] = _unescape(value)
        elif key == "DTSTART":
            current["start"] = _parse_dt(value)
        elif key == "DESCRIPTION":
            current["description"] = _unescape(value)
        elif key == "LOCATION":
            current["location"] = _unescape(value)
        elif key == "ATTENDEE":
            m = re.search(r"CN=([^;:]+)", key_part, re.IGNORECASE)
            current["attendees"].append(m.group(1) if m else value.replace("mailto:", ""))
    return events
