import os
import sys

from django.apps import AppConfig


class CoreConfig(AppConfig):
    name = 'core'

    def ready(self):
        # Only start the auto-watch thread in the actual server process: not
        # during migrate/makemigrations/etc., and - under `runserver`'s
        # autoreloader - not in the parent watcher process (RUN_MAIN is only
        # set to "true" in the reloaded child that actually serves requests),
        # so the thread doesn't start twice.
        if 'runserver' not in sys.argv:
            return
        if os.environ.get('RUN_MAIN') != 'true':
            return
        from . import watcher
        watcher.start_folder_watcher()
