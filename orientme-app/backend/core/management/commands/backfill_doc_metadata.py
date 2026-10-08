"""Fills the new document metadata (doc type, topic tags, signal, version label,
document date) for files that were ingested before those fields existed.

Safe by construction: pure code (no LLM, no network), deterministic, fast, and
idempotent - it only touches a file whose metadata has never been filled
(meta_state is blank) and never one a person has confirmed or corrected; a
second run changes nothing. Not run automatically.

    python manage.py backfill_doc_metadata --dry-run
    python manage.py backfill_doc_metadata
    python manage.py backfill_doc_metadata --meetings   # also meeting type / "who said what" for existing meetings
"""

from django.core.management.base import BaseCommand

from core import doc_meta
from core.models import ExtractedMeta, IngestedFile


class Command(BaseCommand):
    help = "Backfill doc_type / topic_tags / signal / version / date for existing files (idempotent, code-only)."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Report what would change; write nothing.")
        parser.add_argument(
            "--meetings", action="store_true",
            help="Also fill meeting_type / meeting_sequence / speaker_turns on existing meetings "
            "(only rows with no manual type and no speaker turns yet).",
        )

    def handle(self, *args, **options):
        dry = options["dry_run"]
        files_touched = files_seen = 0
        for f in IngestedFile.objects.filter(meta_state="").iterator():
            files_seen += 1
            if doc_meta.apply_auto_metadata(f, save=not dry):
                files_touched += 1

        meetings_touched = 0
        if options["meetings"]:
            for m in ExtractedMeta.objects.select_related("ingested_file").iterator():
                fields = doc_meta.auto_meeting_fields(
                    m.meeting_title, doc_meta.primary_filename(m.ingested_file), m.ingested_file.extracted_text, m
                )
                changed = [k for k, v in fields.items() if getattr(m, k) != v]
                if not changed:
                    continue
                meetings_touched += 1
                if not dry:
                    for k in changed:
                        setattr(m, k, fields[k])
                    m.save(update_fields=changed)  # extracted_at is left alone

        verb = "would fill" if dry else "filled"
        self.stdout.write(f"Files checked (never filled before): {files_seen}; {verb} metadata for {files_touched}.")
        if options["meetings"]:
            self.stdout.write(f"Meetings: {verb} type/speaker turns for {meetings_touched}.")
