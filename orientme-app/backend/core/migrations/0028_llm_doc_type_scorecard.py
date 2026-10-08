from django.db import migrations, models


class Migration(migrations.Migration):
    """8 Oct 2026. Additive only: one new "Opportunity Scorecard" document type,
    one new doc_type_source value ("llm", a type decided by reading a file's
    CONTENT rather than its name), and llm_checked_hash (the content hash the
    content check last ran on, so an unchanged file is never sent to the LLM
    twice). No existing row changes meaning."""

    dependencies = [
        ("core", "0027_sales_metadata_notes_speakers"),
    ]

    operations = [
        migrations.AddField(
            model_name="ingestedfile",
            name="llm_checked_hash",
            field=models.CharField(blank=True, default="", max_length=64),
        ),
        migrations.AlterField(
            model_name="ingestedfile",
            name="doc_type",
            field=models.CharField(
                blank=True,
                choices=[
                    ("email", "Email"),
                    ("meeting_transcript", "Meeting Transcript"),
                    ("mom_action_items", "MoM / Action Items"),
                    ("proposal", "Proposal"),
                    ("quotation_sow", "Quotation / SOW"),
                    ("prd_brd", "PRD / BRD"),
                    ("project_charter", "Project Charter"),
                    ("project_plan", "Project Plan"),
                    ("stakeholder_map", "Stakeholder Map"),
                    ("opportunity_scorecard", "Opportunity Scorecard"),
                    ("report", "Report"),
                    ("notes", "Notes"),
                    ("other", "Other"),
                ],
                default="",
                max_length=30,
            ),
        ),
        migrations.AlterField(
            model_name="ingestedfile",
            name="doc_type_source",
            field=models.CharField(
                blank=True,
                choices=[("auto", "Auto"), ("manual", "Manual"), ("llm", "AI (read from content)")],
                default="",
                max_length=10,
            ),
        ),
    ]
