"""Remove the Inbox feature (added 30 Sep 2026, withdrawn 1 Oct 2026).

Schema: drops the "general" topic type and the "inbox" recording-event
status from the field choices (choices are Python-level only, no DB change).

Data: nothing is deleted. A leftover Inbox topic (topic_type="general") is
converted into an ordinary project named "Former Inbox (unsorted files)" so
its files stay searchable and the owner can move them into real projects or
delete the project through the normal UI. RecordingEvents still marked
"inbox" become "routed" (the files really do live in that topic now).
"""

from django.db import migrations, models

LEGACY_NAME = "Former Inbox (unsorted files)"


def convert_inbox_data(apps, schema_editor):
    Topic = apps.get_model("core", "Topic")
    RecordingEvent = apps.get_model("core", "RecordingEvent")
    for topic in Topic.objects.filter(topic_type="general"):
        topic.topic_type = "project"
        topic.name = LEGACY_NAME
        topic.one_liner = "Files that were in the removed Inbox - move them into real projects or delete this project."
        topic.save()
    RecordingEvent.objects.filter(status="inbox").update(
        status="routed", detail="Was in the removed Inbox - now in its own project."
    )


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0025_alter_recordingevent_status_alter_topic_topic_type"),
    ]

    operations = [
        migrations.RunPython(convert_inbox_data, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="recordingevent",
            name="status",
            field=models.CharField(choices=[('routed', 'Routed to existing project'), ('pending_new_project', 'New project suggested - awaiting your decision'), ('auto_created', 'New project created'), ('needs_review', 'Needs manual assignment'), ('pre_existing', 'Existed before auto-watch (not processed)'), ('error', 'Error'), ('dismissed', 'Dismissed - not tracked')], default='needs_review', max_length=20),
        ),
        migrations.AlterField(
            model_name="topic",
            name="topic_type",
            field=models.CharField(choices=[('project', 'Project'), ('area', 'Area'), ('process', 'Process'), ('person', 'Person'), ('customer', 'Customer'), ('opportunity', 'Opportunity')], default='project', max_length=20),
        ),
    ]
