"""Automatic folder watcher - closes the gap between what got built (scan is a
manual button click) and what Venki himself described in the 29 Sep Orient-Me
meeting: a pipeline that "will watch the folder, see if any new transcript,
any new recording has come... then it will fix that recording, convert that
into audio, and then the audio will continue to transcript" with nobody
clicking anything.

Deliberately a plain background thread, not Celery/a scheduler service -
matches this project's existing "no Celery, use threading" convention
(see views.py's _start_scan_job) and this app's own scripts/watchdog.ps1,
which already polls on a timer for the same reason: no extra moving part to
install or keep alive separately from the Django process itself.

Every linked SourceFolder (across every Topic) is re-scanned on each tick.
ingestion.ingest_folder() already skips any file whose content hash hasn't
changed, so a quiet folder costs one cheap os.walk per tick, not repeat work
- the same logic a manual "Scan folder now" click already relies on."""

import logging
import threading
import time

from django.conf import settings

from . import ingestion, recordings
from .models import SourceFolder

logger = logging.getLogger(__name__)

_started = False


def _tick():
    for folder in SourceFolder.objects.select_related("topic").all():
        try:
            result = ingestion.ingest_folder(folder.topic, folder.path)
        except Exception:  # noqa: BLE001 - one bad folder shouldn't stop the watcher
            logger.exception("Auto-watch: failed scanning folder %s (topic %s)",
                              folder.path, folder.topic_id)
            continue
        if result["added"] or result["updated"]:
            logger.info(
                "Auto-watch: topic %s (%s) - %d new, %d updated file(s) picked up from %s",
                folder.topic_id, folder.topic.name, result["added"], result["updated"], folder.path,
            )

    # The one shared central Recordings folder (not a per-topic
    # SourceFolder) - see core/recordings.py for the route/auto-create
    # pipeline. Runs on the same tick/thread rather than a second one -
    # one background poller for the whole app, not one per feature.
    try:
        recordings.tick_central_recordings_folder()
    except Exception:  # noqa: BLE001 - one failed tick shouldn't kill the watcher loop
        logger.exception("Auto-watch: central recordings-folder tick failed")

    # Venki's own manual "drop random data here, shortcut to mark to
    # projects" folder (30 Sep) - separate from the auto-routed Recordings
    # folder above, same tick/thread.
    try:
        recordings.tick_manual_drop_folder()
    except Exception:  # noqa: BLE001 - one failed tick shouldn't kill the watcher loop
        logger.exception("Auto-watch: manual drop-folder tick failed")


def _loop(interval_seconds):
    while True:
        time.sleep(interval_seconds)
        _tick()


def start_folder_watcher():
    """Starts the watcher thread at most once per process. Safe to call from
    AppConfig.ready() even though Django may call it more than once."""
    global _started
    if _started:
        return
    _started = True
    interval = getattr(settings, "FOLDER_WATCH_INTERVAL_SECONDS", 60)
    thread = threading.Thread(target=_loop, args=(interval,), daemon=True,
                               name="orientme-folder-watcher")
    thread.start()
    logger.info("Auto-watch: folder watcher started (every %ss)", interval)
