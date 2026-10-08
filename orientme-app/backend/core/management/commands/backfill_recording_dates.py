"""One-time backfill for a real, reported bug: every RecordingEvent created
before recording_date existed (including every 'pre_existing' row bulk-
classified when the watcher first turned on) only ever had detected_at -
when this app happened to notice the file, not when the meeting actually
happened. Safe to re-run: only ever touches rows where recording_date is
still null, so it never overwrites a value a later, already-correct
process_new_recording() call already set."""

from django.core.management.base import BaseCommand

from core.models import RecordingEvent
from core.recordings import _resolve_recording_date


class Command(BaseCommand):
    help = "Backfills RecordingEvent.recording_date for rows created before that field existed."

    def handle(self, *args, **options):
        qs = RecordingEvent.objects.filter(recording_date__isnull=True)
        total = qs.count()
        fixed = 0
        for event in qs:
            resolved = _resolve_recording_date(event.file_path)
            if resolved:
                event.recording_date = resolved
                event.save(update_fields=["recording_date"])
                fixed += 1
        self.stdout.write(self.style.SUCCESS(f"Checked {total} row(s), backfilled recording_date on {fixed}."))
