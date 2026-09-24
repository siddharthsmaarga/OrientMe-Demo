import hashlib
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

from . import corrections, extraction, ics_import, ingestion, llm_brief, mbox_import
from .models import (
    CaseSummary,
    ChatMessage,
    ConnectorStatus,
    ExtractedMeta,
    GlobalChatMessage,
    IngestedFile,
    Loop,
    Profile,
    ScanJob,
    Settings,
    SourceFolder,
    TASK_STATUSES,
    Task,
    Topic,
    Workflow,
)
from .serializers import (
    CaseSummarySerializer,
    GlobalChatMessageSerializer,
    LoopSerializer,
    ScanJobSerializer,
    TaskSerializer,
    TopicDetailSerializer,
    TopicSerializer,
    WorkflowSerializer,
)


def _profile_payload(user):
    profile = getattr(user, "profile", None)
    role = profile.role if profile else "user"
    return {
        "username": user.username,
        "display_name": user.get_full_name() or user.username,
        "role": role,
    }


def _user_role(request):
    profile = getattr(request.user, "profile", None)
    return profile.role if profile else "user"


def _require_admin(request):
    """Returns a 403 Response if the logged-in user isn't an Admin, else
    None - the exact split the login system exists for: Admin can change
    Settings/Connectors, User can only view them."""
    if _user_role(request) != "admin":
        return Response({"error": "Admin access required for this action."}, status=403)
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
    }


def _extract_and_store(ingested_file):
    """Runs meeting-metadata extraction over one IngestedFile's text and
    upserts (or clears) its ExtractedMeta row. No-op (and no error) when
    there's nothing usable to extract from yet - matches every call site's
    existing "don't let a bad file break the request" convention.

    Prefers the LLM (configured in Settings) when a key is present: it can
    actually judge whether a document is a meeting record at all, not just
    pattern-match it, so a report or README doesn't get a fabricated
    "meeting title" out of its first line. Falls back to the pure-Python
    heuristic - gated on a real transcript signal via
    extraction.looks_like_meeting_transcript, for the same reason - when no
    key is configured or the LLM call fails."""
    text = ingested_file.extracted_text or ""
    if ingested_file.extraction_error or not text.strip():
        return

    settings = _current_llm_settings()
    if settings.get("llm_api_key"):
        try:
            fields = llm_brief.extract_meeting_metadata_llm(text, settings)
        except Exception:  # noqa: BLE001 - fall back to the heuristic below
            fields = None
        if fields is not None:
            meeting_date = None
            raw_date = fields.get("meeting_date")
            if raw_date:
                try:
                    meeting_date = datetime.strptime(raw_date, "%Y-%m-%d").date()
                except ValueError:
                    meeting_date = None
            attendees = fields.get("attendees") or []
            # Deterministic backstop on top of the LLM's own is_meeting call -
            # real, confirmed bug: a security review of a tool literally named
            # "Meeting Diarizer" came back is_meeting=True purely because the
            # word "meeting" appears in its title. A genuine meeting record
            # almost always has a real date or named attendees; is_meeting=
            # True with neither is far more likely a misjudged report.
            is_meeting = bool(fields.get("is_meeting")) and (meeting_date is not None or len(attendees) > 0)
            if not is_meeting:
                ExtractedMeta.objects.filter(ingested_file=ingested_file).delete()
                Task.objects.filter(source_file=ingested_file).delete()
                return
            hours = [
                {"name": h.get("name", ""), "hours": h.get("hours", 0), "date": raw_date or None}
                for h in (fields.get("employee_hours") or [])
                if h.get("name")
            ]
            ExtractedMeta.objects.update_or_create(
                ingested_file=ingested_file,
                defaults={
                    "meeting_title": fields.get("meeting_title") or "",
                    "meeting_date": meeting_date,
                    "meeting_time": fields.get("meeting_time") or "",
                    "attendees": attendees,
                    "agenda": fields.get("agenda") or "",
                    "achieved": fields.get("achieved") or "",
                    "employee_hours": hours,
                },
            )
            # Add any action items not already created from this same file -
            # never touches an existing task's status/due_date, so re-scanning
            # doesn't reset progress someone already made on the board.
            existing_titles = set(
                Task.objects.filter(source_file=ingested_file).values_list("title", flat=True)
            )
            for item in fields.get("action_items") or []:
                title = (item.get("title") or "").strip()
                if not title or title in existing_titles:
                    continue
                due_date = None
                if item.get("due_date"):
                    try:
                        due_date = datetime.strptime(item["due_date"], "%Y-%m-%d").date()
                    except ValueError:
                        due_date = None
                Task.objects.create(
                    topic=ingested_file.topic,
                    source_file=ingested_file,
                    title=title,
                    assignee=item.get("assignee") or "",
                    due_date=due_date,
                )
            return
        # LLM call failed - fall through to the gated heuristic below.

    if not extraction.looks_like_meeting_transcript(text):
        ExtractedMeta.objects.filter(ingested_file=ingested_file).delete()
        Task.objects.filter(source_file=ingested_file).delete()
        return

    meta = extraction.extract_meeting_metadata(text)
    hours = extraction.extract_employee_hours(text)
    ExtractedMeta.objects.update_or_create(
        ingested_file=ingested_file,
        defaults={
            "meeting_title": meta["meeting_title"],
            "meeting_date": meta["meeting_date"],
            "meeting_time": meta["meeting_time"],
            "attendees": meta["attendees"],
            "agenda": meta["agenda"],
            "achieved": meta["achieved"],
            "employee_hours": hours,
        },
    )


# The 7 structured brief fields, shared by _ask_topic (persisting
# field_sources), the CSV export/import actions, and _brief_html_page's
# per-paragraph rendering - one list so all three can't drift apart.
SUMMARY_FIELD_NAMES = [
    "why_now", "current_state", "history", "customer_thoughts",
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
            why_now=fields.get("why_now") or "",
            current_state=fields.get("current_state") or "",
            history=fields.get("history") or "",
            customer_thoughts=fields.get("customer_thoughts") or "",
            promises_made=fields.get("promises_made") or "",
            next_step=fields.get("next_step") or "",
            risks_and_gaps=fields.get("risks_and_gaps") or "",
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
        timestamp as folder ingestion."""
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
                    },
                )
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
        not a hidden call) - see CONTEXT_BRIEF_QUESTION."""
        topic = self.get_object()
        _ask_topic(topic, CONTEXT_BRIEF_QUESTION)
        summary = topic.summaries.first()
        if not summary:
            return Response(
                {"error": "Could not generate a brief yet - add some files to this project first."},
                status=400,
            )
        return Response(CaseSummarySerializer(summary).data)

    @action(detail=True, methods=["get"])
    def meeting_metadata(self, request, pk=None):
        topic = self.get_object()
        metas = (
            ExtractedMeta.objects.filter(ingested_file__topic=topic)
            .select_related("ingested_file")
            .order_by(F("meeting_date").desc(nulls_last=True), "-ingested_file__first_added_at")
        )
        data = [
            {
                "id": m.id,
                "file_display_name": m.ingested_file.display_name,
                "file_path": m.ingested_file.path,
                "meeting_title": m.meeting_title,
                "timeline_title": _meeting_timeline_title(m.meeting_title),
                "meeting_date": m.meeting_date.isoformat() if m.meeting_date else None,
                "meeting_time": m.meeting_time,
                "attendees": m.attendees,
                "agenda": m.agenda,
                "achieved": m.achieved,
            }
            for m in _dedupe_meetings(metas)
        ]
        return Response(data)

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
    """Kanban-board tasks - see models.Task. Created automatically by
    _extract_and_store from a meeting's action items; a person only ever
    moves one between columns (status) or adjusts its due_date here, never
    creates/renames/deletes one directly, hence title/assignee/topic/
    source_file being read-only on the serializer."""

    serializer_class = TaskSerializer

    def get_queryset(self):
        qs = Task.objects.select_related("topic", "source_file")
        topic_id = self.request.query_params.get("topic")
        if topic_id:
            qs = qs.filter(topic_id=topic_id)
        return qs

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


class CalendarView(APIView):
    """Across ALL topics, every ExtractedMeta row with a real meeting_date
    PLUS every Task with a due_date - optionally filtered to one topic via
    ?topic_id=<id>. One merged, date-sorted list so a calendar widget can
    highlight a day for either a meeting or a commitment, tagged by "kind".
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
                    "attendees": m.attendees,
                    "agenda": m.agenda,
                    "achieved": m.achieved,
                }
            )

        task_qs = Task.objects.filter(due_date__isnull=False).select_related("topic")
        if topic_id:
            task_qs = task_qs.filter(topic_id=topic_id)
        for t in task_qs:
            data.append(
                {
                    "kind": "task",
                    "date": t.due_date.isoformat(),
                    "topic_id": t.topic.id,
                    "topic_name": t.topic.name,
                    "topic_type": t.topic.topic_type,
                    "id": t.id,
                    "title": t.title,
                    "assignee": t.assignee,
                    "status": t.status,
                    "due_date": t.due_date.isoformat(),
                }
            )

        data.sort(key=lambda e: e["date"], reverse=True)
        return Response(data)


class GlobalSearchView(APIView):
    """The universal search (Ctrl/Cmd+K) - one query fanned out across
    project names/one-liners/related people, meeting attendees
    (stakeholders), task titles, and file names, each capped to a handful of
    results. Server-side so the frontend never has to ship every project's
    full data down just to filter it client-side."""

    def get(self, request):
        q = (request.query_params.get("q") or "").strip()
        if not q:
            return Response({"projects": [], "stakeholders": [], "tasks": [], "files": []})

        projects = Topic.objects.filter(
            Q(name__icontains=q) | Q(one_liner__icontains=q) | Q(related_people__icontains=q)
        )[:8]

        # Attendee names live inside ExtractedMeta.attendees, a JSON list -
        # SQLite has no clean "does this list contain a substring" query via
        # the ORM, so this filters in Python. Bounded to a few hundred rows
        # (one per ingested file that looked like a meeting, not per byte of
        # file content), which is fine at this app's real scale.
        stakeholder_hits = []
        seen = set()
        metas = ExtractedMeta.objects.exclude(attendees=[]).select_related(
            "ingested_file__topic"
        )[:300]
        for m in metas:
            for name in m.attendees or []:
                if q.lower() in name.lower():
                    key = (name.lower(), m.ingested_file.topic_id)
                    if key in seen:
                        continue
                    seen.add(key)
                    stakeholder_hits.append(
                        {
                            "name": name,
                            "topic_id": m.ingested_file.topic_id,
                            "topic_name": m.ingested_file.topic.name,
                        }
                    )
            if len(stakeholder_hits) >= 8:
                break

        tasks = Task.objects.filter(title__icontains=q).select_related("topic")[:8]
        files = IngestedFile.objects.filter(display_name__icontains=q).select_related("topic")[:8]

        return Response(
            {
                "projects": [
                    {"id": t.id, "name": t.name, "one_liner": t.one_liner, "topic_type": t.topic_type}
                    for t in projects
                ],
                "stakeholders": stakeholder_hits[:8],
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
                    }
                    for f in files
                ],
            }
        )


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
    KEYS = ["llm_provider", "llm_api_key", "llm_model", "llm_base_url", "default_directory", "stale_after_days"]

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
        denied = _require_admin(request)
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
  max-width:780px;margin:0 auto;padding:32px 24px 60px}
.eyebrow{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8a8578}
h1{font-size:26px;margin:4px 0 18px;color:#1a1a1a}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;
  background:#e6f6f6;color:#0a6e6e;margin-left:8px;vertical-align:middle}
.card{background:#fff;border:1px solid #e8e5da;border-radius:10px;padding:20px 22px;margin-bottom:20px}
.answer{white-space:pre-wrap;line-height:1.55;font-size:14.5px}
.note{font-size:12px;color:#9a6a1a;background:#fff6e6;border:1px solid #f0dcae;border-radius:6px;
  padding:8px 12px;margin-bottom:14px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#6b6658;margin:0 0 10px}
.src{font-size:12px;color:#8a8578;margin:2px 0;display:flex;align-items:center;gap:8px}
.src-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.edit-link{flex:none;font-size:11px;font-weight:600;color:#0096af;text-decoration:none;
  border:1px solid #cdeaea;border-radius:999px;padding:1px 9px;white-space:nowrap}
.edit-link:hover{background:#e6f6f6}
.answer-summary{font-size:15px;line-height:1.5;color:#1a1a1a;margin:0 0 18px;padding-bottom:16px;
  border-bottom:1px solid #eee}
.brief-section{margin-bottom:16px}
.brief-section h3{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:#0096af;
  margin:0 0 4px;font-weight:700}
.para{font-size:14px;line-height:1.55;color:#2a2a28;margin:0 0 4px;white-space:pre-wrap}
.para-src{display:flex;flex-wrap:wrap;gap:6px;margin:0}
.para-src .edit-link{color:#8a8578;border-color:#e8e5da;font-weight:500}
.para-src .edit-link:hover{background:#f3f1ea;color:#0096af;border-color:#cdeaea}
.tl-item{border-left:2px solid #e8e5da;padding:2px 0 14px 16px;margin-left:2px;position:relative}
.tl-item::before{content:'';position:absolute;left:-5px;top:6px;width:8px;height:8px;border-radius:50%;
  background:#0096af}
.tl-date{font-size:11px;color:#9a9587}
.tl-title{font-size:13.5px;font-weight:600;margin:2px 0 3px}
.tl-body{font-size:12.5px;color:#57534a;line-height:1.5}
"""


# Section labels for the structured per-paragraph render - next_step is
# explicitly labeled a recommendation (matches the V0 PRD's "Recommended
# next step - labelled as a recommendation, not a fact" requirement, a real
# gap this same rendering rewrite closes alongside the source-attribution one).
_BRIEF_SECTION_LABELS = [
    ("why_now", "Why now"),
    ("current_state", "Current state"),
    ("history", "History"),
    ("customer_thoughts", "What the customer thinks"),
    ("promises_made", "Commitments & open loops"),
    ("next_step", "Recommended next step"),
    ("risks_and_gaps", "Risks & gaps"),
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


def _brief_html_page(topic, answer, summary=None):
    tl_meetings = _dedupe_meetings(
        ExtractedMeta.objects.filter(ingested_file__topic=topic)
        .select_related("ingested_file")
        .order_by(F("meeting_date").desc(nulls_last=True), "-ingested_file__first_added_at")
    )[:8]
    tl_summaries = topic.summaries.all()[:8]  # CaseSummary.Meta.ordering = ["-generated_at"]

    timeline_events = []
    for m in tl_meetings:
        if not m.meeting_date:
            continue
        timeline_events.append(
            {
                "sort": m.meeting_date.isoformat(),
                "date": m.meeting_date.strftime("%d %b %Y"),
                "title": _meeting_timeline_title(m.meeting_title),
                "body": _truncate(m.achieved or m.agenda),
            }
        )
    for s in tl_summaries:
        title, body = _summary_timeline_entry(s)
        timeline_events.append(
            {"sort": s.generated_at.isoformat(), "date": s.generated_at.strftime("%d %b %Y"), "title": title, "body": body}
        )
    timeline_events.sort(key=lambda e: e["sort"], reverse=True)  # newest first

    note_html = ""
    if not answer.get("is_llm") and answer.get("generation_note"):
        note_html = f'<p class="note">{html_escape(answer["generation_note"])}</p>'

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

        summary_html = ""
        if (summary.answer_summary or "").strip():
            summary_html = f'<p class="answer-summary">{html_escape(summary.answer_summary)}</p>'

        # "Open first" - the 3-5 most valuable things to look at before the
        # per-section detail below, per the PRD's own output contract.
        open_first_links = _source_links(summary.sources_used)
        open_first_html = (
            f'<div class="brief-section"><h3>Open first</h3><p class="para-src">{"".join(open_first_links)}</p></div>'
            if open_first_links
            else ""
        )

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

        body_html = f"{summary_html}{open_first_html}{sections_html}"
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
        body_html = f'<div class="answer">{html_escape(answer.get("content") or "")}</div>{sources_html}'

    timeline_html = "".join(
        f'<div class="tl-item"><p class="tl-date">{e["date"]}</p>'
        f'<p class="tl-title">{html_escape(e["title"])}</p>'
        f'<p class="tl-body">{html_escape(e["body"])}</p></div>'
        for e in timeline_events
    ) or '<p class="src">Nothing dated yet.</p>'

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{html_escape(topic.name)} — OrientMe</title>
<style>{BRIEF_HTML_STYLE}</style></head><body>
<p class="eyebrow">OrientMe</p>
<h1>{html_escape(topic.name)}<span class="badge">{html_escape(topic.get_topic_type_display())}</span></h1>
<div class="card">
  {note_html}
  {body_html}
</div>
<h2>Timeline</h2>
{timeline_html}
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
        denied = _require_admin(request)
        if denied:
            return denied
        obj, _ = ConnectorStatus.objects.update_or_create(
            slug=slug, defaults={"status": "requested", "requested_at": timezone.now()}
        )
        return Response(_connector_payload(obj))


class ConnectorResetView(APIView):
    """Withdraws a pending request, back to 'Not Connected'."""

    def post(self, request, slug):
        denied = _require_admin(request)
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


class LoginView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        username = (request.data.get("username") or "").strip()
        password = request.data.get("password") or ""
        user = authenticate(request, username=username, password=password)
        if user is None:
            return Response({"error": "Incorrect username or password."}, status=400)
        django_login(request, user)
        return Response(_profile_payload(user))


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
    """Self-service password change - any logged-in person (Admin or User)
    can change their own password; this has nothing to do with the
    Admin/User role split, which only governs Settings/Connectors."""

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
