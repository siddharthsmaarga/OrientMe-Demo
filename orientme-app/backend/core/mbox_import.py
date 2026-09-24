"""Pure-stdlib .mbox parsing (Python's own `mailbox` module - no new
dependency) for the "Email export" data-fetch option: a person exports
their mailbox to a single .mbox file and drops it in, same as any other
upload. .pst (Outlook's proprietary format) is NOT supported here - reading
it needs a real third-party parser (no stdlib equivalent), which is a
genuinely separate piece of work, not something to fake."""

import mailbox
import os
import tempfile


def parse_mbox_bytes(raw_bytes):
    """Returns a list of {"subject", "from", "to", "date", "body"} dicts.
    mailbox needs a real file path (it can't parse from an in-memory
    buffer), so this writes to a temp file, parses, then cleans up."""
    fd, path = tempfile.mkstemp(suffix=".mbox")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw_bytes)
        box = mailbox.mbox(path)
        try:
            return [_extract_message(msg) for msg in box]
        finally:
            # mailbox.mbox keeps its own file handle open until closed - on
            # Windows (unlike POSIX) that handle blocks the os.remove()
            # below, so it must be closed explicitly first.
            box.close()
    finally:
        os.remove(path)


def _extract_message(msg):
    return {
        "subject": msg.get("Subject", "") or "(no subject)",
        "from": msg.get("From", "") or "",
        "to": msg.get("To", "") or "",
        "date": msg.get("Date", "") or "",
        "body": _get_body(msg),
    }


def _get_body(msg):
    if msg.is_multipart():
        parts = []
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and not part.get_filename():
                parts.append(_decode_payload(part))
        return "\n".join(p for p in parts if p).strip()
    return (_decode_payload(msg) or "").strip()


def _decode_payload(part):
    try:
        raw = part.get_payload(decode=True)
        if raw is None:
            return ""
        return raw.decode(part.get_content_charset() or "utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - one malformed part shouldn't break the whole import
        return ""
