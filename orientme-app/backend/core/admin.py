from django.contrib import admin

from .models import ChatMessage, ExtractedMeta, IngestedFile, Settings, SourceFolder, Topic, Workflow

admin.site.register(Topic)
admin.site.register(SourceFolder)
admin.site.register(IngestedFile)
admin.site.register(ChatMessage)
admin.site.register(Settings)
admin.site.register(ExtractedMeta)
admin.site.register(Workflow)
