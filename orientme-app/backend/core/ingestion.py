"""Reads whatever's actually in a topic's local folders and extracts plain
text from each file - the MVP ingestion model from the 17 Sep sprint
discussion: no SharePoint/Graph API connection, just files someone has
already downloaded or synced locally, read from an explicitly approved path.

Deliberately shallow (top-level + one level of subfolders, a small set of
text-bearing formats) - this is the backend-first MVP slice, not a full
document-management crawler.
"""

import email
import hashlib
import os
from email.policy import default as _email_default_policy

from .models import IngestedFile

SUPPORTED_EXTENSIONS = {".txt", ".md", ".eml"}  # .eml needs no extra package - stdlib email module

try:
    import extract_msg

    SUPPORTED_EXTENSIONS.add(".msg")
except ImportError:
    extract_msg = None

try:
    import docx  # python-docx

    SUPPORTED_EXTENSIONS.add(".docx")
except ImportError:
    docx = None

try:
    from pypdf import PdfReader

    SUPPORTED_EXTENSIONS.add(".pdf")
except ImportError:
    PdfReader = None

try:
    import openpyxl

    SUPPORTED_EXTENSIONS.update({".xlsx", ".xlsm"})
except ImportError:
    openpyxl = None

try:
    import pptx  # python-pptx

    SUPPORTED_EXTENSIONS.add(".pptx")
except ImportError:
    pptx = None


def _extract_xlsx(path):
    # Every sheet, every row, tab-separated - keeps numbers/dates readable
    # as plain text for the same downstream extraction (meeting metadata,
    # employee hours, action items) that already runs on any other file,
    # rather than a separate spreadsheet-specific pipeline.
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    parts = []
    for sheet in wb.worksheets:
        parts.append(f"--- Sheet: {sheet.title} ---")
        for row in sheet.iter_rows(values_only=True):
            cells = ["" if c is None else str(c) for c in row]
            if any(cell.strip() for cell in cells):
                parts.append("\t".join(cells))
    return "\n".join(parts)


def _extract_eml(path):
    # Plain stdlib parsing, no LLM/heuristics involved - headers give the
    # who/when/subject signals the same way a transcript's own header does,
    # body text is walked to prefer the plain-text part over HTML.
    with open(path, "rb") as f:
        msg = email.message_from_binary_file(f, policy=_email_default_policy)
    header = (
        f"From: {msg.get('From', '')}\nTo: {msg.get('To', '')}\n"
        f"Date: {msg.get('Date', '')}\nSubject: {msg.get('Subject', '')}\n"
    )
    body_part = msg.get_body(preferencelist=("plain", "html"))
    body = body_part.get_content() if body_part else ""
    return header + "\n" + body


def _extract_msg(path):
    m = extract_msg.Message(path)
    try:
        header = (
            f"From: {m.sender or ''}\nTo: {m.to or ''}\n"
            f"Date: {m.date or ''}\nSubject: {m.subject or ''}\n"
        )
        return header + "\n" + (m.body or "")
    finally:
        m.close()


def _extract_pptx(path):
    prs = pptx.Presentation(path)
    parts = []
    for i, slide in enumerate(prs.slides, start=1):
        lines = []
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                lines.append(shape.text_frame.text.strip())
            if shape.has_table:
                for row in shape.table.rows:
                    lines.append("\t".join(cell.text for cell in row.cells))
        if lines:
            parts.append(f"--- Slide {i} ---\n" + "\n".join(lines))
    return "\n\n".join(parts)


def extract_text(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".txt", ".md"):
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    if ext == ".eml":
        return _extract_eml(path)
    if ext == ".msg" and extract_msg is not None:
        return _extract_msg(path)
    if ext == ".docx" and docx is not None:
        d = docx.Document(path)
        return "\n".join(p.text for p in d.paragraphs if p.text.strip())
    if ext == ".pdf" and PdfReader is not None:
        reader = PdfReader(path)
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    if ext in (".xlsx", ".xlsm") and openpyxl is not None:
        return _extract_xlsx(path)
    if ext == ".pptx" and pptx is not None:
        return _extract_pptx(path)
    raise ValueError(f"Unsupported or unavailable extractor for {ext}")


def _walk_files(folder_path, max_depth=1):
    """Top level plus one level of subfolders - enough for a real project
    folder without accidentally ingesting an entire OneDrive root."""
    base_depth = folder_path.rstrip(os.sep).count(os.sep)
    for root, dirs, files in os.walk(folder_path):
        depth = root.rstrip(os.sep).count(os.sep) - base_depth
        if depth >= max_depth:
            dirs[:] = []
        for name in files:
            if os.path.splitext(name)[1].lower() in SUPPORTED_EXTENSIONS:
                yield os.path.join(root, name)


def ingest_folder(topic, folder_path, on_progress=None):
    """Reads every supported file under folder_path, skipping ones whose
    content hash hasn't changed since last time - so re-ingesting a large
    folder after adding one new file is cheap, matching the PRD's own
    'refresh only changed material' goal. on_progress(done, total), if
    given, is called after each file - this is the fast local-I/O phase, so
    it mostly matters for a real progress bar on a very large folder."""
    results = {"scanned": 0, "added": 0, "updated": 0, "unchanged": 0, "errors": []}

    if not os.path.isdir(folder_path):
        results["errors"].append(f"Folder not found: {folder_path}")
        return results

    paths = list(_walk_files(folder_path))
    total = len(paths)
    for i, path in enumerate(paths, 1):
        results["scanned"] += 1
        try:
            with open(path, "rb") as f:
                raw = f.read()
            content_hash = hashlib.sha256(raw).hexdigest()

            existing = IngestedFile.objects.filter(topic=topic, path=path).first()
            if existing and existing.content_hash == content_hash:
                results["unchanged"] += 1
                continue
            is_new = existing is None

            text = extract_text(path)
            IngestedFile.objects.update_or_create(
                topic=topic,
                path=path,
                defaults={
                    "extracted_text": text,
                    "content_hash": content_hash,
                    "extraction_error": "",
                },
            )
            results["added" if is_new else "updated"] += 1
        except Exception as e:  # noqa: BLE001 - a bad file shouldn't abort the whole ingest
            IngestedFile.objects.update_or_create(
                topic=topic,
                path=path,
                defaults={"extraction_error": str(e)},
            )
            results["errors"].append(f"{path}: {e}")
        finally:
            if on_progress:
                on_progress(i, total)

    return results
