from django.conf import settings as django_settings
from django.db import models


USER_ROLES = [
    ("admin", "Admin"),
    ("user", "User"),
]


class Profile(models.Model):
    """Extends Django's own User with the one thing this app's access
    control needs: a role. Admin can change Settings (LLM provider/API key)
    and request Connector access; User can view both but never change or
    request anything - the exact split the login system was built for."""

    user = models.OneToOneField(
        django_settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="profile"
    )
    role = models.CharField(max_length=10, choices=USER_ROLES, default="user")

    def __str__(self):
        return f"{self.user.username} ({self.role})"


TOPIC_TYPES = [
    ("project", "Project"),
    ("area", "Area"),
    ("process", "Process"),
    ("person", "Person"),
    ("customer", "Customer"),
    ("opportunity", "Opportunity"),
    (
        "general",
        "General / Inbox",
    ),  # the one singleton "doesn't fit a real project yet" bucket - see
    # recordings.get_or_create_inbox_topic. Not something a person picks
    # when creating a topic by hand (TopicAutocomplete/create-project forms
    # filter it out) - it only ever exists as the one auto-created landing
    # spot for a folder/file drop that didn't confidently match anything.
]


class Topic(models.Model):
    """The core entity from the 17 Sep sprint discussion: 'a topic might be a
    project, an area, a process, a person, a customer, an opportunity' - each
    with a common data structure (folder locations, related people) plus a
    type-specific brief shape."""

    name = models.CharField(max_length=200)
    topic_type = models.CharField(max_length=20, choices=TOPIC_TYPES, default="project")
    one_liner = models.CharField(max_length=300, blank=True)
    related_people = models.CharField(
        max_length=500, blank=True, help_text="Comma-separated names, plain text for MVP"
    )
    auto_created = models.BooleanField(
        default=False,
        help_text="True when a recording's transcript was routed here by core/recordings.py's "
        "auto-create pipeline rather than a person clicking 'create topic' - shown as a badge so "
        "an LLM-guessed project is never mistaken for one a person deliberately set up.",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.name


class SourceFolder(models.Model):
    """A local folder path a person has pointed this topic at - matches the
    MVP ingestion decision from the sprint meeting: no live SharePoint/Graph
    API connection, just local files someone has already downloaded/synced
    (e.g. via 'add shortcut to OneDrive', or an IMAP export), read from an
    explicitly approved path."""

    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="folders")
    path = models.CharField(max_length=1000)
    added_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.path


SOURCE_METHODS = [
    ("folder", "Lookup folder"),
    ("upload", "Uploaded file"),
    ("paste", "Pasted text"),
    ("folder_upload", "Uploaded folder"),
    ("email_import", "Email import"),
    ("calendar_import", "Calendar import"),
]


class IngestedFile(models.Model):
    """One piece of ingested content - out of a lookup folder, a direct
    upload, or pasted text. Keeps its extracted text and a content hash so
    re-scanning a folder only re-reads files that actually changed - the
    PRD's 'reuse cached summaries, refresh only changed material' goal, at
    the simplest level that actually matters for MVP.

    first_added_at is the real reference timestamp - captured once, the
    moment this piece of content was first added, and never changed after
    that, even if the file's own content is later updated. last_ingested_at
    tracks the most recent refresh (a folder re-scan finding a changed
    file) - the two answer different questions ("when did we first get
    this" vs "when did we last confirm it's current")."""

    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="files")
    path = models.CharField(max_length=1000)
    display_name = models.CharField(max_length=300, blank=True)
    source_method = models.CharField(max_length=20, choices=SOURCE_METHODS, default="folder")
    extracted_text = models.TextField(blank=True)
    content_hash = models.CharField(max_length=64, blank=True)
    extraction_error = models.CharField(max_length=300, blank=True)
    first_added_at = models.DateTimeField(auto_now_add=True)
    last_ingested_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("topic", "path")]
        ordering = ["-first_added_at"]

    def __str__(self):
        return self.display_name or self.path


FEEDBACK_CHOICES = [("up", "Helpful"), ("down", "Not helpful")]


class ChatMessage(models.Model):
    """One turn in a topic's 'ask' history - the chat box Venki described
    ('there will be a chat box... you just prompt'). Assistant messages
    store which files their answer drew on, so every claim can be traced
    back to a source, per the PRD's own requirement.

    `feedback` is the "orientation run" evaluation capture Venki asked for
    directly in the 30 Sep AI Adoption Sprint Meeting: "I should be able to
    say thumbs up or thumbs down... this should be done as a reusable
    component... it should be unobtrusive" - the foundation for the
    "hill-climbing"/evaluation harness he described (a later, bigger watcher-
    agent piece, not built here - this is just the capture step it depends
    on). One assistant message IS one orientation run in his own framing."""

    ROLE_CHOICES = [("user", "User"), ("assistant", "Assistant")]

    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="messages")
    role = models.CharField(max_length=10, choices=ROLE_CHOICES)
    content = models.TextField()
    source_files = models.JSONField(default=list, blank=True)
    is_llm = models.BooleanField(default=True)
    generation_note = models.CharField(max_length=300, blank=True)
    feedback = models.CharField(max_length=10, choices=FEEDBACK_CHOICES, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]


class GlobalChatMessage(models.Model):
    """One turn in the 'common chatbox' history - same shape as ChatMessage,
    but not tied to a single Topic: answers are grounded in every ingested
    file across every topic at once, for "what's going on everywhere"
    questions rather than one topic's own ask box.

    `feedback` - see ChatMessage's own docstring; same "orientation run"
    capture, just for this cross-topic chat instead of a per-topic one."""

    ROLE_CHOICES = ChatMessage.ROLE_CHOICES

    role = models.CharField(max_length=10, choices=ROLE_CHOICES)
    content = models.TextField()
    source_files = models.JSONField(default=list, blank=True)
    is_llm = models.BooleanField(default=True)
    generation_note = models.CharField(max_length=300, blank=True)
    feedback = models.CharField(max_length=10, choices=FEEDBACK_CHOICES, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]


class Settings(models.Model):
    """Same shape as the Weekly Summary Agent / HR Hiring Agent LLM settings
    table - a single-row key/value store for the OpenRouter key, so nothing
    is hardcoded and the app degrades gracefully (a plain 'ingested, not yet
    summarized' response) if it's blank."""

    key = models.CharField(max_length=100, unique=True)
    value = models.CharField(max_length=500, blank=True)

    def __str__(self):
        return self.key

    @classmethod
    def get(cls, key, default=""):
        try:
            return cls.objects.get(key=key).value
        except cls.DoesNotExist:
            return default

    @classmethod
    def set(cls, key, value):
        obj, _ = cls.objects.get_or_create(key=key)
        obj.value = value
        obj.save()
        return obj


class ExtractedMeta(models.Model):
    """Structured facts pulled out of one IngestedFile's text via pure-Python
    heuristics (see extraction.py) - no LLM involved. One-to-one with
    IngestedFile so re-ingesting the same content just updates this row
    instead of piling up duplicates."""

    ingested_file = models.OneToOneField(IngestedFile, on_delete=models.CASCADE, related_name="meta")
    meeting_title = models.CharField(max_length=300, blank=True)
    meeting_date = models.DateField(null=True, blank=True)
    # Kept as a plain string like "10:00 AM" rather than a TimeField -
    # parsing free-text meeting times reliably isn't worth the complexity here.
    meeting_time = models.CharField(max_length=20, blank=True)
    attendees = models.JSONField(default=list, blank=True)
    agenda = models.TextField(blank=True)
    achieved = models.TextField(blank=True)
    # list of {"name": str, "hours": float, "date": "YYYY-MM-DD" or None}
    employee_hours = models.JSONField(default=list, blank=True)
    extracted_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.meeting_title or f"meta for {self.ingested_file_id}"


WORKFLOW_TYPES = [
    ("payroll_approval", "Payroll Approval"),
]

WORKFLOW_STATUSES = [
    ("pending", "Pending"),
    ("approved", "Approved"),
]


class Workflow(models.Model):
    """A ready-made, computed-on-demand consolidated view awaiting approval -
    e.g. 'here is everyone's hours this month, approve it' - rather than
    someone hand-computing it from scattered documents every time. A fresh
    call always creates a new row (see compute_payroll): the point is a
    ready-made view to approve, not a live-recalculating dashboard."""

    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="workflows")
    workflow_type = models.CharField(max_length=30, choices=WORKFLOW_TYPES, default="payroll_approval")
    status = models.CharField(max_length=10, choices=WORKFLOW_STATUSES, default="pending")
    computed_data = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    approved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.get_workflow_type_display()} ({self.status})"


TASK_STATUSES = [
    ("backlog", "Backlog"),
    ("in_progress", "In Progress"),
    ("done", "Completed"),
]


class Task(models.Model):
    """An action item / work item pulled out of a meeting by the LLM
    extractor (llm_brief.extract_action_items_llm) - the Kanban-board unit
    from the 18 Sep standup transcript: "we need
    ideally a planner task board... backlog, in progress, completed."

    Tied to the ingested_file it came from so re-scanning that file doesn't
    duplicate a task that already exists (see core.views._extract_and_store's
    dedup-by-title-per-file logic), but a task's own status/due_date survive
    independently once created - re-extraction never resets a task someone
    has already moved across the board.

    Deliberately NOT the same concept as Commitment (see that model's own
    docstring) - a Task is work that needs to be done; a Commitment is a
    person's promise, which may optionally point at one of these via
    Commitment.linked_task."""

    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="tasks")
    source_file = models.ForeignKey(
        "IngestedFile", on_delete=models.SET_NULL, null=True, blank=True, related_name="tasks"
    )
    title = models.CharField(max_length=300)
    assignee = models.CharField(max_length=120, blank=True)
    due_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=TASK_STATUSES, default="backlog")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["due_date", "created_at"]

    def __str__(self):
        return self.title


COMMITMENT_STATUSES = [
    ("open", "Open"),
    ("in_progress", "In Progress"),
    ("done", "Done"),
]


class Commitment(models.Model):
    """A person's explicit promise/obligation - deliberately NOT the same
    concept as Task. "Venkatesh will provide the architecture proposal by
    Friday" is a commitment; "Create Azure architecture proposal" is the
    task it may produce. A commitment can optionally point at the task it
    produced (linked_task), but the two are independent records with
    independent lifecycles - completing one never implies the other."""

    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="commitments")
    source_file = models.ForeignKey(
        "IngestedFile", on_delete=models.SET_NULL, null=True, blank=True, related_name="commitments"
    )
    linked_task = models.ForeignKey(
        Task, on_delete=models.SET_NULL, null=True, blank=True, related_name="commitments"
    )
    person = models.CharField(max_length=150)
    commitment = models.CharField(max_length=500)
    date_made = models.DateField(null=True, blank=True)
    due_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=COMMITMENT_STATUSES, default="open")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["due_date", "created_at"]

    def __str__(self):
        return f"{self.person}: {self.commitment}"


DECISION_STATUSES = [
    ("decided", "Decided"),
    ("reversed", "Reversed"),
]


class Decision(models.Model):
    """A structured, persistent decision record for a topic - the piece the
    free-text `CaseSummary.decisions_made` field can't provide: something
    that keeps its own identity/status across regenerations instead of being
    rewritten fresh every time the brief is regenerated. Mirrors Task's own
    shape/conventions (topic FK, nullable source_file, created_at) rather
    than inventing a new pattern."""

    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="decisions")
    source_file = models.ForeignKey(
        "IngestedFile", on_delete=models.SET_NULL, null=True, blank=True, related_name="decisions"
    )
    decision = models.CharField(max_length=500)
    context = models.TextField(blank=True, help_text="Why this was decided / the reasoning.")
    participants = models.CharField(
        max_length=300, blank=True, help_text="Free text - no structured People model exists yet."
    )
    decided_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=DECISION_STATUSES, default="decided")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-decided_date", "-created_at"]

    def __str__(self):
        return self.decision


RISK_STATUSES = [
    ("open", "Open"),
    ("mitigated", "Mitigated"),
    ("closed", "Closed"),
]


class Risk(models.Model):
    """A structured, tracked risk/blocker for a topic - distinct from
    CaseSummary.risks_and_gaps (the AI's own free-text read, regenerated
    fresh every brief). This is the persistent record a person maintains:
    what could prevent the project from succeeding, its impact, who owns
    it, and whether it's still open. Mirrors Decision's own shape/
    conventions rather than inventing a new pattern."""

    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="risks")
    source_file = models.ForeignKey(
        "IngestedFile", on_delete=models.SET_NULL, null=True, blank=True, related_name="risks"
    )
    description = models.CharField(max_length=500)
    impact = models.TextField(blank=True)
    owner = models.CharField(max_length=150, blank=True)
    status = models.CharField(max_length=20, choices=RISK_STATUSES, default="open")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.description


class CaseSummary(models.Model):
    """A persisted AI 'Context Brief' for a topic (a Case, in the generic
    sense: project, process, person, customer, area, or opportunity) - the
    Sybill-style pre-meeting brief pattern, generalized. Previously every
    'current state / next step' answer only ever lived inside one chat
    reply and had to be re-asked to see again; this keeps the latest one on
    the topic itself so the topic page can show it at a glance without a
    fresh question. A fresh row per generation, never updated in place -
    same 'always create, never overwrite' pattern as Workflow - so how the
    situation evolved over time is never lost, and `.first()` (ordering
    below) always gets the latest."""

    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="summaries")
    answer_summary = models.TextField(
        blank=True, help_text="The direct 2-4 sentence answer to the question asked, for the top of the brief."
    )
    why_now = models.TextField(blank=True)
    current_state = models.TextField(blank=True)
    history = models.TextField(blank=True)
    customer_thoughts = models.TextField(blank=True)
    customer_need = models.TextField(blank=True)
    proposed_solution = models.TextField(blank=True)
    latest_updates = models.TextField(blank=True)
    decisions_made = models.TextField(blank=True)
    meeting_prep = models.TextField(blank=True)
    promises_made = models.TextField(blank=True)
    next_step = models.TextField(blank=True)
    risks_and_gaps = models.TextField(blank=True)
    sources_used = models.JSONField(default=list, blank=True)
    field_sources = models.JSONField(
        default=dict,
        blank=True,
        help_text="Per-field citations, e.g. {'current_state': ['path1', 'path2']} - "
        "lets the brief page show a source link right next to the paragraph it "
        "actually backs, instead of one undifferentiated file list at the bottom "
        "(real, direct feedback: 'cluttered, I cannot understand which paragraph "
        "is referring to what file'). Keyed by the same field names as this model's "
        "own text fields; a field missing here just renders with no inline source.",
    )
    generated_at = models.DateTimeField(auto_now_add=True)
    is_manual_edit = models.BooleanField(
        default=False,
        help_text="True when this row came from a CSV re-import (a person's own "
        "edit on top of the AI's first-level draft), not a fresh AI generation - "
        "Venki's own 'creation part, editing part' split, 22 Sep sprint meeting.",
    )

    class Meta:
        ordering = ["-generated_at"]

    def __str__(self):
        return f"Summary for topic {self.topic_id} @ {self.generated_at}"


class ProjectState(models.Model):
    """The explicit, always-current 'Project Intelligence' layer for a
    topic - distinct from CaseSummary, which is deliberately append-only
    (a fresh row per AI generation, never updated in place). This is the
    opposite: one row per topic, edited in place, so a person can state
    the current position directly without touching the original source
    documents. Deliberately no separate history table - one prior value
    is enough ("previous value available if needed") without
    over-engineering an audit trail nobody asked for."""

    topic = models.OneToOneField(Topic, on_delete=models.CASCADE, related_name="state")
    current_position = models.TextField(blank=True)
    previous_position = models.TextField(
        blank=True, help_text="The value of current_position just before the most recent edit."
    )
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.CharField(max_length=150, blank=True)

    def __str__(self):
        return f"State for topic {self.topic_id} @ {self.updated_at}"


class Loop(models.Model):
    """A saved 'Ask OrientMe' question someone wants to re-run later (the
    global cross-topic ask, not a single topic's own chat) - "Save this
    prompt as a Loop". Only the prompt and its manual run history are
    tracked here; there is no scheduler behind this yet, so "recurring"
    today means "one click away to run again", not "runs automatically on
    a cadence" - the same honestly-scoped gap the PRD itself defers
    (proactive/scheduled preparation is explicitly a Later item)."""

    question = models.CharField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)
    last_run_at = models.DateTimeField(null=True, blank=True)
    run_count = models.IntegerField(default=0)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.question


SCAN_JOB_STATUSES = [
    ("scanning", "Scanning files"),
    ("extracting", "Extracting details"),
    ("done", "Done"),
    ("error", "Error"),
]


class ScanJob(models.Model):
    """Tracks one "Scan folder now" run in the background, so the frontend
    can poll and show a real progress bar / auto-refresh when it's done,
    instead of one long blocking request the user has to sit through with
    no feedback and then manually reload to see the result. `scanning` is
    the fast local file-reading pass; `extracting` is the slow one (LLM
    calls, one per file that needs it) - total_files/processed_files track
    whichever phase is currently running."""

    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="scan_jobs")
    status = models.CharField(max_length=12, choices=SCAN_JOB_STATUSES, default="scanning")
    total_files = models.IntegerField(default=0)
    processed_files = models.IntegerField(default=0)
    scanned = models.IntegerField(default=0)
    added = models.IntegerField(
        default=0, help_text="Brand new files never seen before this scan - distinct from "
        "'updated' (an existing file whose content changed). The 'X new files found' count "
        "a person can actually act on, not lumped in with edits to files already known."
    )
    updated = models.IntegerField(default=0)
    unchanged = models.IntegerField(default=0)
    error_message = models.CharField(max_length=500, blank=True)
    started_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-started_at"]


RECORDING_EVENT_STATUSES = [
    ("routed", "Routed to existing project"),
    ("pending_new_project", "New project suggested - awaiting your decision"),
    ("auto_created", "New project created"),
    ("needs_review", "Needs manual assignment"),
    ("inbox", "Filed to Inbox - no confident project match"),
    ("pre_existing", "Existed before auto-watch (not processed)"),
    ("error", "Error"),
    ("dismissed", "Dismissed - not tracked"),
]


class RecordingEvent(models.Model):
    """One row per recording file core/recordings.py's central-folder
    watcher has found in the one shared Recordings folder (not a per-topic
    SourceFolder - see watcher.py for that) - the review trail for the
    auto-route/auto-create pipeline, and the data source for the frontend's
    Transcripts page. Every outcome gets a row, including errors and "needs
    review" - so that page always has an honest, complete picture of what
    the pipeline actually did, never a silent background action nobody can
    see.

    Creating a brand new project is never done silently (Ayush's explicit
    correction, 29 Sep: "dont automatically add... give user an option to
    do so or reject the project creation") - when the LLM router thinks a
    recording describes a project that doesn't exist yet, it lands here as
    status='pending_new_project' with its suggestion recorded in the
    suggested_* fields below, NOT as an already-created Topic. A person
    reviews it on the Transcripts page and either confirms (optionally
    editing the name first) or rejects it - see
    RecordingEventViewSet.confirm_new_project/reject_new_project."""

    file_path = models.CharField(max_length=1000, unique=True)
    detected_at = models.DateTimeField(auto_now_add=True)
    topic = models.ForeignKey(
        Topic, on_delete=models.SET_NULL, null=True, blank=True, related_name="recording_events"
    )
    ingested_file = models.ForeignKey(
        "IngestedFile", on_delete=models.SET_NULL, null=True, blank=True, related_name="recording_events"
    )
    status = models.CharField(max_length=20, choices=RECORDING_EVENT_STATUSES, default="needs_review")
    engine_used = models.CharField(max_length=30, blank=True)
    detail = models.CharField(
        max_length=500, blank=True,
        help_text="Short human-readable note - matched-topic reasoning, error text, etc.",
    )
    suggested_topic_name = models.CharField(max_length=200, blank=True)
    suggested_topic_one_liner = models.CharField(max_length=300, blank=True)
    suggested_topic_type = models.CharField(max_length=20, blank=True)
    pending_extracted_text = models.TextField(
        blank=True,
        help_text="The already-transcribed text, held here only while status='pending_new_project' "
        "so confirming doesn't require re-transcribing the recording - cleared once confirmed/rejected.",
    )
    meeting_summary = models.TextField(
        blank=True,
        help_text="On-demand LLM summary of just this one recording's transcript - generated "
        "only when a person clicks 'Generate Summary' on the transcript detail page, never "
        "automatically alongside transcription itself.",
    )
    summary_generated_at = models.DateTimeField(null=True, blank=True)
    recording_date = models.DateTimeField(
        null=True, blank=True,
        help_text="The real meeting/recording date - parsed from the Teams filename's own "
        "YYYYMMDD_HHMMSS stamp, or the file's mtime as a fallback. Never the same thing as "
        "detected_at, which is only when this app's watcher happened to notice the file and "
        "can be days (or, for anything bulk-classified as pre_existing, months) later than "
        "when the meeting actually happened - the real bug this field fixes.",
    )
    SOURCE_CHOICES = [
        ("watched_folder", "Watched Recordings Folder"),
        ("manual_drop", "Manual Drop Folder"),
    ]
    source = models.CharField(max_length=20, choices=SOURCE_CHOICES, default="watched_folder")
    diarization_result = models.TextField(
        blank=True,
        help_text="On-demand, LLM-produced structured breakdown (participants, decisions, "
        "action items, parked items, per-speaker summary) generated only when a person clicks "
        "'Diarize' - matches the shape of the reference example in 'Diarizer Example/'.",
    )
    diarization_generated_at = models.DateTimeField(null=True, blank=True)
    speaker_transcript = models.TextField(
        blank=True,
        help_text="On-demand, LLM-produced transcript reformatted as speaker name + timestamp "
        "+ speech per line - generated only when a person clicks 'Generate Transcript'.",
    )
    speaker_transcript_generated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-detected_at"]

    def __str__(self):
        return f"{self.file_path} -> {self.topic_id or '(unassigned)'}"


CONNECTOR_STATUSES = [
    ("not_connected", "Not Connected"),
    ("requested", "Requested — Pending Review"),
    ("connected", "Connected"),
]


class ConnectorStatus(models.Model):
    """The current state of one external-app connector (Teams, Outlook,
    Gmail, etc.) on the Connectors page. Deliberately NOT an OAuth token
    store - this app doesn't grant itself any real access yet ("now we will
    not give the permissions" - explicit product decision). Clicking
    'Request Access' only records that someone asked for it, so IT/security
    can review before any real integration is built; the actual connector
    catalog (names, logos, what each one would read, what permissions it
    would need) is static UI copy that lives in the frontend, not here -
    this table only tracks the one thing that's genuinely stateful: whether
    a given slug has been requested. A slug with no row here is implicitly
    "not_connected" - no need to pre-seed every known connector."""

    slug = models.CharField(max_length=50, unique=True)
    status = models.CharField(max_length=20, choices=CONNECTOR_STATUSES, default="not_connected")
    requested_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"{self.slug}: {self.status}"


SEARCH_RESULT_KINDS = [
    ("project", "Project"),
    ("person", "Person"),
    ("topic", "Topic"),
    ("file", "File"),
    ("task", "Task"),
    ("none", "No selection"),
]


class SearchLog(models.Model):
    """One row per universal-search (Ctrl/Cmd+K) session - what was typed,
    how many results came back, and what (if anything) got picked. This is
    Venki's "review the output so we can analyse and improve it later" ask
    for the search feature specifically: not a live feature, a record for
    someone to read afterward (browsable in Django admin) to see real
    queries that found nothing, or found the wrong thing, and fix the
    search logic accordingly. Written once per session (on a pick, or when
    the palette closes with a real query that never led to one) - never
    per keystroke, so this stays a record of real search attempts, not
    debounced typing noise."""

    query = models.CharField(max_length=300)
    result_count = models.PositiveIntegerField(default=0)
    chosen_kind = models.CharField(max_length=10, choices=SEARCH_RESULT_KINDS, default="none")
    chosen_label = models.CharField(max_length=300, blank=True)
    topic = models.ForeignKey(Topic, on_delete=models.SET_NULL, null=True, blank=True)
    user = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.query!r} -> {self.chosen_kind}"

