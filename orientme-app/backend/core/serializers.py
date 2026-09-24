from rest_framework import serializers

from .models import (
    CaseSummary,
    ChatMessage,
    ExtractedMeta,
    GlobalChatMessage,
    IngestedFile,
    Loop,
    ScanJob,
    SourceFolder,
    Task,
    Topic,
    Workflow,
)


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
    topic_name = serializers.CharField(source="topic.name", read_only=True)

    class Meta:
        model = Task
        fields = [
            "id",
            "topic",
            "topic_name",
            "source_file",
            "title",
            "assignee",
            "due_date",
            "status",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["topic", "source_file", "title", "assignee", "created_at", "updated_at"]


class SourceFolderSerializer(serializers.ModelSerializer):
    class Meta:
        model = SourceFolder
        fields = ["id", "path", "added_at"]


class ExtractedMetaSerializer(serializers.ModelSerializer):
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
        ]


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

    class Meta:
        model = IngestedFile
        fields = [
            "id",
            "path",
            "display_name",
            "source_method",
            "artifact_type",
            "content_hash",
            "extraction_error",
            "first_added_at",
            "last_ingested_at",
            "meta",
        ]

    def get_meta(self, obj):
        meta = getattr(obj, "meta", None)
        if meta is None:
            return None
        return ExtractedMetaSerializer(meta).data

    def get_artifact_type(self, obj):
        if obj.source_method == "email_import":
            return "email"
        if obj.source_method == "calendar_import":
            return "meeting"
        return "meeting" if getattr(obj, "meta", None) else "file"


class ChatMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = ChatMessage
        fields = ["id", "role", "content", "source_files", "is_llm", "generation_note", "created_at"]


class GlobalChatMessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = GlobalChatMessage
        fields = ["id", "role", "content", "source_files", "is_llm", "generation_note", "created_at"]


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
            "folders",
            "file_count",
            "last_activity_at",
            "latest_risks_and_gaps",
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
