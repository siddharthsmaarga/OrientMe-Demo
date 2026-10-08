from django.contrib import admin

from .models import (
    ChatMessage,
    Contact,
    ExtractedMeta,
    IngestedFile,
    MeetingNote,
    SearchLog,
    SourceFolder,
    Topic,
    Workflow,
)

admin.site.register(Topic)
admin.site.register(SourceFolder)
admin.site.register(IngestedFile)
admin.site.register(ChatMessage)
# Settings is deliberately NOT registered here: it holds the API key in plain
# text, and the Django admin would let anyone with a staff account read or
# change it without the settings password the Settings page asks for.
admin.site.register(ExtractedMeta)
admin.site.register(Workflow)
admin.site.register(MeetingNote)
admin.site.register(Contact)


@admin.register(SearchLog)
class SearchLogAdmin(admin.ModelAdmin):
    """The review surface Venki asked for: browse real search queries and
    what people actually picked (or didn't), to spot bad matches / dead
    queries and improve GlobalSearchView from real usage rather than
    guessing. list_filter on chosen_kind makes "show me every search that
    found nothing" a two-click filter, not a query someone has to write."""

    list_display = ("query", "chosen_kind", "chosen_label", "topic", "result_count", "user", "created_at")
    list_filter = ("chosen_kind", "created_at")
    search_fields = ("query", "chosen_label")
    date_hierarchy = "created_at"
    ordering = ("-created_at",)
