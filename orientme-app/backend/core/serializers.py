from rest_framework import serializers

from . import doc_meta, extraction
from .models import (
    CaseSummary,
    ChatMessage,
    Commitment,
    Contact,
    Decision,
    ExtractedMeta,
    GlobalChatMessage,
    IngestedFile,
    Loop,
    MeetingNote,
    ProjectState,
    RecordingEvent,
    Risk,
    ScanJob,
    SourceFolder,
    Task,
    Topic,
    Workflow,
)


class RecordingEventSerializer(serializers.ModelSerializer):
    topic_name = serializers.CharField(source="topic.name", read_only=True)
    file_name = serializers.SerializerMethodField()
    speaker_turn_count = serializers.SerializerMethodField()
    speaker_turns_generating = serializers.SerializerMethodField()
    llm_key_configured = serializers.SerializerMethodField()

    class Meta:
        model = RecordingEvent
        fields = [
            "id",
            "file_path",
            "file_name",
            "detected_at",
            "recording_date",
            "source",
            "topic",
            "topic_name",
            "ingested_file",
            "status",
            "engine_used",
            "detail",
            "suggested_topic_name",
            "suggested_topic_one_liner",
            "suggested_topic_type",
            "meeting_summary",
            "summary_generated_at",
            "diarization_result",
            "diarization_generated_at",
            "speaker_transcript",
            "speaker_transcript_generated_at",
            # --- "who spoke what" conversation (5 Oct 2026)
            "speaker_turns",
            "speaker_turns_source",
            "speaker_turn_count",
            "speaker_turns_generating",
            "llm_key_configured",
        ]
        read_only_fields = [
            "file_path", "detected_at", "recording_date", "source", "ingested_file", "engine_used",
            "summary_generated_at", "diarization_generated_at", "speaker_transcript_generated_at",
            "speaker_turns", "speaker_turns_source",
        ]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        # The list endpoint leaves the (potentially large) turns out; the
        # detail/action responses include them.
        if self.context.get("omit_speaker_turns"):
            data.pop("speaker_turns", None)
        return data

    def get_speaker_turn_count(self, obj):
        return len(obj.speaker_turns or [])

    def get_speaker_turns_generating(self, obj):
        from .recordings import speaker_turns_generating

        return speaker_turns_generating(obj.id)

    def get_llm_key_configured(self, obj):
        # Only a yes/no - the key itself is never exposed. Cached per
        # serializer instance (a list serializes many rows with one child).
        if not hasattr(self, "_llm_key_flag"):
            from .models import Settings

            self._llm_key_flag = bool((Settings.get("llm_api_key", "") or "").strip())
        return self._llm_key_flag

    def get_file_name(self, obj):
        import os

        return os.path.basename(obj.file_path)


class ScanJobSerializer(serializers.ModelSerializer):
    class Meta:
        model = ScanJob
        fields = [
            "id",
            "status",
            "total_files",
            "processed_files",
            "scanned",
            "added",
            "updated",
            "unchanged",
            "error_message",
            "started_at",
            "finished_at",
        ]


class TaskSerializer(serializers.ModelSerializer):
    """An action item is the action itself, the date it was added (created_at)
    and where it came from (the source_* fields) - nothing else (Ayush, 8 Oct
    2026). due_date is deliberately NOT exposed: the column still exists in the
    database (the CSV round-trip reads it), but no screen shows or sets it."""

    topic_name = serializers.CharField(source="topic.name", read_only=True)
    source_name = serializers.SerializerMethodField()
    source_label = serializers.SerializerMethodField()
    source_date = serializers.SerializerMethodField()

    class Meta:
        model = Task
        fields = [
            "id",
            "topic",
            "topic_name",
            "source_file",
            "source_name",
            "source_label",
            "source_date",
            "title",
            "assignee",
            "status",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["source_file", "created_at", "updated_at"]

    def get_source_name(self, obj):
        f = obj.source_file
        if not f:
            return ""
        return doc_meta.primary_filename(f) or f.display_name or ""

    def get_source_label(self, obj):
        return doc_meta.display_title(obj.source_file) if obj.source_file else ""

    def get_source_date(self, obj):
        f = obj.source_file
        if not f:
            return None
        meta = getattr(f, "meta", None)
        when = (meta.meeting_date if meta else None) or f.document_date
        return when.isoformat() if when else f.first_added_at.date().isoformat()


class CommitmentSerializer(serializers.ModelSerializer):
    linked_task_title = serializers.CharField(source="linked_task.title", read_only=True, default="")

    class Meta:
        model = Commitment
        fields = [
            "id",
            "topic",
            "source_file",
            "linked_task",
            "linked_task_title",
            "person",
            "commitment",
            "date_made",
            "due_date",
            "status",
            "created_at",
        ]
        read_only_fields = ["source_file", "created_at"]


class RiskSerializer(serializers.ModelSerializer):
    class Meta:
        model = Risk
        fields = ["id", "topic", "source_file", "description", "impact", "owner", "status", "created_at"]
        read_only_fields = ["source_file", "created_at"]


class DecisionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Decision
        fields = [
            "id",
            "topic",
            "source_file",
            "decision",
            "context",
            "participants",
            "decided_date",
            "status",
            "created_at",
        ]
        read_only_fields = ["source_file", "created_at"]


class ProjectStateSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProjectState
        fields = ["id", "topic", "current_position", "previous_position", "updated_at", "updated_by"]
        read_only_fields = ["topic", "previous_position", "updated_at", "updated_by"]


class SourceFolderSerializer(serializers.ModelSerializer):
    class Meta:
        model = SourceFolder
        fields = ["id", "path", "added_at"]


class ExtractedMetaSerializer(serializers.ModelSerializer):
    meeting_type_label = serializers.SerializerMethodField()
    speaker_summary = serializers.SerializerMethodField()

    class Meta:
        model = ExtractedMeta
        fields = [
            "id",
            "meeting_title",
            "meeting_date",
            "meeting_time",
            "attendees",
            "agenda",
            "achieved",
            "employee_hours",
            "extracted_at",
            "meeting_type",
            "meeting_type_label",
            "meeting_sequence",
            "meeting_type_source",
            "speaker_summary",
        ]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        # Older rows may hold the "Not captured (...)" placeholder as an
        # attendee; hide it on read without rewriting stored data.
        data["attendees"] = extraction.clean_attendees(data.get("attendees"))
        return data

    def get_meeting_type_label(self, obj):
        return doc_meta.MEETING_TYPE_LABELS.get(obj.meeting_type, "")

    def get_speaker_summary(self, obj):
        return extraction.summarize_speakers(obj.speaker_turns)


class WorkflowSerializer(serializers.ModelSerializer):
    class Meta:
        model = Workflow
        fields = ["id", "topic", "workflow_type", "status", "computed_data", "created_at", "approved_at"]


class CaseSummarySerializer(serializers.ModelSerializer):
    class Meta:
        model = CaseSummary
        fields = [
            "id",
            "answer_summary",
            "why_now",
            "current_state",
            "history",
            "customer_thoughts",
            "customer_need",
            "proposed_solution",
            "latest_updates",
            "decisions_made",
            "meeting_prep",
            "promises_made",
            "next_step",
            "risks_and_gaps",
            "sources_used",
            "field_sources",
            "generated_at",
            "is_manual_edit",
        ]


class LoopSerializer(serializers.ModelSerializer):
    class Meta:
        model = Loop
        fields = ["id", "question", "created_at", "last_run_at", "run_count"]
        read_only_fields = ["created_at", "last_run_at", "run_count"]


def artifact_type_for(obj):
    """The long-standing derived artifact type (email / meeting / file), now
    also reporting "email" for .eml/.msg files and anything classified as an
    email - previously a folder-scanned or uploaded .eml was just "file"."""
    if obj.source_method == "email_import":
        return "email"
    if obj.source_method == "calendar_import":
        return "meeting"
    path = (obj.path or "").lower()
    if path.endswith((".eml", ".msg")) or obj.doc_type == "email":
        return "email"
    return "meeting" if getattr(obj, "meta", None) else "file"


def file_metadata_payload(obj):
    """The new (5 Oct 2026) metadata fields of an IngestedFile as plain JSON."""
    return {
        "doc_type": obj.doc_type,
        "doc_type_label": doc_meta.DOC_TYPE_LABELS.get(obj.doc_type, ""),
        "doc_type_source": obj.doc_type_source,
        # What the file IS (template name + version), not what it is called.
        "display_title": doc_meta.display_title(obj),
        "topic_tags": obj.topic_tags,
        "topic_tag_list": doc_meta.normalize_tags(obj.topic_tags),
        "signal": obj.signal,
        "meta_state": obj.meta_state,
        "review_notes": obj.review_notes,
        "version_label": obj.version_label,
        "document_date": obj.document_date.isoformat() if obj.document_date else None,
        "meta_seconds": obj.meta_seconds,
    }


class IngestedFileSerializer(serializers.ModelSerializer):
    # A plain nested ExtractedMetaSerializer would 500 on the reverse OneToOne
    # DoesNotExist when a file hasn't been extracted yet, so this goes through
    # a SerializerMethodField instead and returns None in that case.
    meta = serializers.SerializerMethodField()
    # The generic "polymorphic Artifact" type this content represents -
    # derived, not stored, from source_method + whether a meeting was
    # actually detected in it, so it stays correct without a second field to
    # keep in sync.
    artifact_type = serializers.SerializerMethodField()
    doc_type_label = serializers.SerializerMethodField()
    # The template name this file is shown as ("Opportunity Scorecard",
    # "Proposal V2"), with its real file name second - decided from what the
    # file IS, not what it happens to be called.
    display_title = serializers.SerializerMethodField()
    topic_tag_list = serializers.SerializerMethodField()

    class Meta:
        model = IngestedFile
        fields = [
            "id",
            "path",
            "display_name",
            "display_title",
            "source_method",
            "artifact_type",
            "content_hash",
            "extraction_error",
            "first_added_at",
            "last_ingested_at",
            "meta",
            # --- metadata (5 Oct 2026)
            "doc_type",
            "doc_type_label",
            "doc_type_source",
            "topic_tags",
            "topic_tag_list",
            "signal",
            "meta_state",
            "review_notes",
            "version_label",
            "document_date",
            "meta_seconds",
        ]

    def get_doc_type_label(self, obj):
        return doc_meta.DOC_TYPE_LABELS.get(obj.doc_type, "")

    def get_display_title(self, obj):
        return doc_meta.display_title(obj)

    def get_topic_tag_list(self, obj):
        return doc_meta.normalize_tags(obj.topic_tags)

    def get_meta(self, obj):
        meta = getattr(obj, "meta", None)
        if meta is None:
            return None
        return ExtractedMetaSerializer(meta).data

    def get_artifact_type(self, obj):
        return artifact_type_for(obj)


class ChatMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = ChatMessage
        fields = ["id", "role", "content", "source_files", "is_llm", "generation_note", "feedback", "created_at"]


class GlobalChatMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = GlobalChatMessage
        fields = ["id", "role", "content", "source_files", "is_llm", "generation_note", "feedback", "created_at"]


class TopicSerializer(serializers.ModelSerializer):
    folders = SourceFolderSerializer(many=True, read_only=True)
    file_count = serializers.SerializerMethodField()
    last_activity_at = serializers.SerializerMethodField()
    latest_risks_and_gaps = serializers.SerializerMethodField()

    class Meta:
        model = Topic
        fields = [
            "id",
            "name",
            "topic_type",
            "one_liner",
            "related_people",
            "created_at",
            "auto_created",
            "folders",
            "file_count",
            "last_activity_at",
            "latest_risks_and_gaps",
            "stage",
            "customer_name",
        ]

    def get_file_count(self, obj):
        return obj.files.count()

    # Powers the dashboard's "stale" flag (PRD Should-have: "flag stale...
    # information") - the most recent of a fresh brief or a newly ingested
    # file, whichever is later, so a topic someone is actively re-reading
    # (regenerating briefs) but not adding new files to still counts as alive.
    def get_last_activity_at(self, obj):
        candidates = [obj.created_at]
        latest_summary = obj.summaries.first()  # CaseSummary.Meta.ordering = ["-generated_at"]
        if latest_summary:
            candidates.append(latest_summary.generated_at)
        latest_file = obj.files.order_by("-first_added_at").first()
        if latest_file:
            candidates.append(latest_file.first_added_at)
        return max(candidates).isoformat()

    # Surfaced on the dashboard's "Needs attention" panel so an open risk
    # doesn't require opening every project to notice.
    def get_latest_risks_and_gaps(self, obj):
        latest = obj.summaries.first()
        return (latest.risks_and_gaps or "").strip() if latest else ""


class TopicDetailSerializer(TopicSerializer):
    files = IngestedFileSerializer(many=True, read_only=True)
    messages = ChatMessageSerializer(many=True, read_only=True)

    class Meta(TopicSerializer.Meta):
        fields = TopicSerializer.Meta.fields + ["files", "messages"]


class MeetingNoteSerializer(serializers.ModelSerializer):
    meeting_title = serializers.SerializerMethodField()
    meeting_date = serializers.SerializerMethodField()

    class Meta:
        model = MeetingNote
        fields = ["id", "topic", "meta", "meeting_title", "meeting_date", "text", "author", "created_at"]
        read_only_fields = ["topic", "author", "created_at"]

    def get_meeting_title(self, obj):
        return obj.meta.meeting_title if obj.meta_id else ""

    def get_meeting_date(self, obj):
        return obj.meta.meeting_date.isoformat() if obj.meta_id and obj.meta.meeting_date else None


class ContactSerializer(serializers.ModelSerializer):
    class Meta:
        model = Contact
        fields = ["id", "topic", "name", "organisation", "role", "side", "created_at"]
        read_only_fields = ["topic", "created_at"]
        validators = []  # (topic, name) uniqueness is checked in the view
