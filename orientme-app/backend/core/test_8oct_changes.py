"""Tests for the 8 Oct 2026 changes (Venki's "Shared Context Project Meeting" + Ayush's asks):

- a renamed file is classified by reading its CONTENT (rules first, LLM only when the name cannot be trusted)
- the Opportunity Scorecard document type
- an action item is just the action + the date it was added; clicking it shows where it came from
- one shared login only; changing anything on the Settings page needs a (hardcoded) password

No test calls a real LLM: the model is replaced by a stub function.
"""

from datetime import date
from unittest import mock

from django.contrib.auth.models import User
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from . import doc_meta, evidence, llm_brief, views
from .models import ExtractedMeta, Settings, Task, Topic
from .test_sales_changes import WHISPER_TEXT, api_client, make_file
from .views import _extract_and_store

KEY = {"llm_api_key": "test-key-not-real", "llm_model": "m", "llm_base_url": "http://x"}

# Reads like a proposal but says so nowhere in its (meaningless) name.
PROPOSAL_TEXT = (
    "Proposed solution and commercial terms\n"
    "We propose a three-phase rollout of the planning platform for the client. "
    "Phase one covers discovery and data readiness, phase two the build, phase three the handover. "
    "Total fee for the engagement is quoted below, valid for thirty days."
)
SCORECARD_TEXT = (
    "Opportunity Score Card\nBudget: confirmed\nAuthority: economic buyer met\nNeed: strong\nTimeline: Q4\n"
    "Overall score 78 out of 100, recommended to pursue."
)
NEUTRAL_TEXT = (
    "Some pages of text that were pasted together over a few weeks, covering many small things "
    "that do not clearly belong to any one kind of document at all."
)


def stub_answer(doc_type, confidence=0.95):
    """A stand-in for llm_brief.call_structured that always gives one answer."""
    calls = []

    def call(prompt, tool_name, description, parameters, settings, timeout=60):
        calls.append(tool_name)
        return {"doc_type": doc_type, "confidence": confidence, "reason": "stub"}

    call.calls = calls
    return call


# ---------------------------------------------------------------------------
# Opportunity Scorecard + how a file is shown
# ---------------------------------------------------------------------------
class ScorecardTests(TestCase):
    def setUp(self):
        self.topic = Topic.objects.create(name="Scorecard topic")

    def test_filename_marks_a_scorecard(self):
        f = make_file(self.topic, "Acme Opportunity Scorecard.xlsx", NEUTRAL_TEXT)
        doc_meta.apply_auto_metadata(f)
        self.assertEqual(f.doc_type, "opportunity_scorecard")

    def test_content_marks_a_scorecard_whatever_the_file_is_called(self):
        f = make_file(self.topic, "q3-sheet.txt", SCORECARD_TEXT)
        doc_meta.apply_auto_metadata(f)
        self.assertEqual(f.doc_type, "opportunity_scorecard")

    def test_display_title_is_the_template_name_not_the_file_name(self):
        f = make_file(self.topic, "q3-sheet.txt", SCORECARD_TEXT)
        doc_meta.apply_auto_metadata(f)
        self.assertEqual(doc_meta.display_title(f), "Opportunity Scorecard")

    def test_untyped_and_notes_files_keep_their_file_name(self):
        f = make_file(self.topic, "random-thoughts.txt", NEUTRAL_TEXT, doc_type="notes")
        self.assertEqual(doc_meta.display_title(f), "random-thoughts.txt")

    def test_the_file_apis_carry_the_template_name_so_lists_can_show_it_first(self):
        f = make_file(self.topic, "q3-sheet.txt", SCORECARD_TEXT)
        doc_meta.apply_auto_metadata(f)
        client = api_client()
        payload = client.get(f"/api/files/{f.id}/metadata/").json()
        self.assertEqual(payload["display_title"], "Opportunity Scorecard")
        topic_files = client.get(f"/api/topics/{self.topic.id}/").json()["files"]
        self.assertEqual(topic_files[0]["display_title"], "Opportunity Scorecard")
        self.assertEqual(topic_files[0]["display_name"], "q3-sheet.txt")

    def test_a_person_can_set_a_file_to_scorecard_and_it_sticks(self):
        f = make_file(self.topic, "x.txt", NEUTRAL_TEXT)
        resp = api_client().patch(f"/api/files/{f.id}/metadata/", {"doc_type": "opportunity_scorecard"}, format="json")
        self.assertEqual(resp.status_code, 200)
        f.refresh_from_db()
        self.assertEqual((f.doc_type, f.doc_type_source), ("opportunity_scorecard", "manual"))


# ---------------------------------------------------------------------------
# Content-based classification (LLM second opinion)
# ---------------------------------------------------------------------------
class ContentCheckTests(TestCase):
    def setUp(self):
        self.topic = Topic.objects.create(name="Renamed files")

    def renamed(self, text=PROPOSAL_TEXT, name="final_v7 (copy).txt", **kw):
        f = make_file(self.topic, name, text, **kw)
        doc_meta.apply_auto_metadata(f)
        return f

    def test_a_renamed_file_is_classified_by_its_content(self):
        f = self.renamed()
        call = stub_answer("proposal")
        self.assertTrue(doc_meta.refine_doc_type_with_llm(f, KEY, call=call))
        f.refresh_from_db()
        self.assertEqual(f.doc_type, "proposal")
        self.assertEqual(f.doc_type_source, "llm")
        self.assertEqual(call.calls, ["classify_document"])

    def test_the_prompt_carries_the_text_and_marks_the_name_as_unreliable(self):
        f = self.renamed()
        seen = {}

        def call(prompt, *a, **k):
            seen["prompt"] = prompt
            return {"doc_type": "proposal", "confidence": 0.9}

        doc_meta.refine_doc_type_with_llm(f, KEY, call=call)
        self.assertIn("three-phase rollout", seen["prompt"])
        self.assertIn("may be wrong", seen["prompt"])

    def test_low_confidence_keeps_the_rule_answer(self):
        f = self.renamed()
        before = f.doc_type
        doc_meta.refine_doc_type_with_llm(f, KEY, call=stub_answer("proposal", 0.5))
        f.refresh_from_db()
        self.assertEqual(f.doc_type, before)
        self.assertNotEqual(f.doc_type_source, "llm")

    def test_other_never_overrides(self):
        f = self.renamed()
        before = f.doc_type
        doc_meta.refine_doc_type_with_llm(f, KEY, call=stub_answer("other", 0.99))
        f.refresh_from_db()
        self.assertEqual(f.doc_type, before)

    def test_an_unknown_type_from_the_model_is_ignored(self):
        f = self.renamed()
        before = f.doc_type
        doc_meta.refine_doc_type_with_llm(f, KEY, call=stub_answer("spaceship", 0.99))
        f.refresh_from_db()
        self.assertEqual(f.doc_type, before)

    def test_no_key_means_no_call_and_the_file_is_not_marked_checked(self):
        f = self.renamed()
        call = stub_answer("proposal")
        self.assertFalse(doc_meta.refine_doc_type_with_llm(f, {"llm_api_key": ""}, call=call))
        self.assertEqual(call.calls, [])
        f.refresh_from_db()
        self.assertEqual(f.llm_checked_hash, "")

    def test_an_unchanged_file_is_not_sent_twice(self):
        f = self.renamed()
        call = stub_answer("proposal")
        doc_meta.refine_doc_type_with_llm(f, KEY, call=call)
        doc_meta.refine_doc_type_with_llm(f, KEY, call=call)
        self.assertEqual(len(call.calls), 1)

    def test_a_manual_choice_is_never_touched_or_even_asked_about(self):
        f = self.renamed(doc_type="notes", doc_type_source="manual")
        call = stub_answer("proposal")
        self.assertFalse(doc_meta.refine_doc_type_with_llm(f, KEY, call=call))
        self.assertEqual(call.calls, [])
        f.refresh_from_db()
        self.assertEqual(f.doc_type, "notes")

    def test_a_confirmed_file_is_left_alone(self):
        f = self.renamed(meta_state="confirmed")
        call = stub_answer("proposal")
        self.assertFalse(doc_meta.refine_doc_type_with_llm(f, KEY, call=call))
        self.assertEqual(call.calls, [])

    def test_a_file_whose_structure_proves_its_type_is_not_sent_to_the_model(self):
        email = "From: Priya <p@x.com>\nTo: venki@maarga.com\nDate: Mon, 03 Aug 2026 10:00:00 +0530\nSubject: Intro call\n\nHi, " + NEUTRAL_TEXT
        f = self.renamed(text=email, name="scan0042.txt")
        call = stub_answer("proposal")
        self.assertFalse(doc_meta.refine_doc_type_with_llm(f, KEY, call=call))
        self.assertEqual(call.calls, [])
        f.refresh_from_db()
        self.assertEqual(f.doc_type, "email")

    def test_a_near_empty_file_is_not_sent_to_the_model(self):
        f = self.renamed(text="ok", name="x.txt")
        call = stub_answer("proposal")
        self.assertFalse(doc_meta.refine_doc_type_with_llm(f, KEY, call=call))
        self.assertEqual(call.calls, [])

    def test_a_decided_type_survives_the_next_extraction_while_the_content_is_unchanged(self):
        f = self.renamed()
        doc_meta.refine_doc_type_with_llm(f, KEY, call=stub_answer("proposal"))
        f.refresh_from_db()
        doc_meta.apply_auto_metadata(f)
        f.refresh_from_db()
        self.assertEqual((f.doc_type, f.doc_type_source), ("proposal", "llm"))

    def test_changed_content_goes_back_to_the_rules_and_is_asked_again(self):
        f = self.renamed()
        doc_meta.refine_doc_type_with_llm(f, KEY, call=stub_answer("proposal"))
        f.refresh_from_db()
        f.extracted_text = NEUTRAL_TEXT + " Edited later with entirely different words about other matters."
        f.content_hash = ""
        f.save()
        doc_meta.apply_auto_metadata(f)
        f.refresh_from_db()
        self.assertEqual(f.doc_type_source, "auto")
        self.assertTrue(doc_meta.needs_content_check(f))

    def test_a_failing_model_never_breaks_the_ingest(self):
        f = self.renamed()

        def boom(*a, **k):
            raise RuntimeError("boom")

        self.assertFalse(doc_meta.safe_refine_doc_type_with_llm(f, KEY, call=boom))
        f.refresh_from_db()
        self.assertEqual(f.llm_checked_hash, "")  # not marked, so it is tried again next time

    def test_decision_thresholds(self):
        decide = doc_meta.decide_from_llm_answer
        # Weak rule answer: 0.75 is enough.
        self.assertEqual(decide("notes", doc_meta.BASIS_WEAK, {"doc_type": "proposal", "confidence": 0.76}), "proposal")
        self.assertIsNone(decide("notes", doc_meta.BASIS_WEAK, {"doc_type": "proposal", "confidence": 0.7}))
        # Overruling something the rules had a real signal for needs more.
        self.assertIsNone(decide("mom_action_items", doc_meta.BASIS_FILENAME, {"doc_type": "proposal", "confidence": 0.8}))
        self.assertEqual(decide("mom_action_items", doc_meta.BASIS_FILENAME, {"doc_type": "proposal", "confidence": 0.9}), "proposal")
        # Garbage in, rules answer out.
        self.assertIsNone(decide("notes", doc_meta.BASIS_WEAK, None))
        self.assertIsNone(decide("notes", doc_meta.BASIS_WEAK, {"doc_type": "proposal", "confidence": "high"}))


class ExtractAndStoreWithContentCheckTests(TestCase):
    """The ingest path: a renamed transcript lands in Meetings and Action Items."""

    TRANSCRIPT = WHISPER_TEXT

    def setUp(self):
        self.topic = Topic.objects.create(name="Renamed transcript")

    def test_a_renamed_meeting_record_is_read_as_a_meeting_when_the_model_says_so(self):
        f = make_file(self.topic, "final_v7.txt", NEUTRAL_TEXT)
        action = [{"title": "Share the revised plan with the client", "assignee": "Ayush"}]
        with mock.patch.object(views, "_current_llm_settings", return_value=dict(KEY)), mock.patch.object(
            llm_brief, "call_structured", side_effect=stub_answer("meeting_transcript")
        ), mock.patch.object(llm_brief, "extract_action_items_llm", return_value=action):
            _extract_and_store(f)
        f.refresh_from_db()
        self.assertEqual((f.doc_type, f.doc_type_source), ("meeting_transcript", "llm"))
        self.assertTrue(ExtractedMeta.objects.filter(ingested_file=f).exists())
        task = Task.objects.get(source_file=f)
        self.assertEqual(task.title, "Share the revised plan with the client")

    def test_without_a_key_a_renamed_file_stays_with_the_rules(self):
        f = make_file(self.topic, "final_v7.txt", NEUTRAL_TEXT)
        with mock.patch.object(views, "_current_llm_settings", return_value={"llm_api_key": ""}), mock.patch.object(
            llm_brief, "call_structured"
        ) as call:
            _extract_and_store(f)
        call.assert_not_called()
        self.assertFalse(ExtractedMeta.objects.filter(ingested_file=f).exists())

    def test_new_action_items_have_no_due_date(self):
        f = make_file(self.topic, "weekly.txt", self.TRANSCRIPT)
        action = [{"title": "Send the deck", "assignee": "", "due_date": "2026-10-31"}]
        with mock.patch.object(views, "_current_llm_settings", return_value=dict(KEY)), mock.patch.object(
            llm_brief, "call_structured", side_effect=stub_answer("meeting_transcript")
        ), mock.patch.object(llm_brief, "extract_action_items_llm", return_value=action):
            _extract_and_store(f)
        self.assertIsNone(Task.objects.get(source_file=f).due_date)


# ---------------------------------------------------------------------------
# Action items: no due date, "added on", and where it came from
# ---------------------------------------------------------------------------
class ActionItemTests(TestCase):
    def setUp(self):
        self.topic = Topic.objects.create(name="Acme deal")
        self.client = api_client()

    def make_task(self, **kw):
        return Task.objects.create(topic=self.topic, title=kw.pop("title", "Send the revised proposal"), **kw)

    def test_the_task_api_does_not_expose_a_due_date_but_shows_when_it_was_added(self):
        self.make_task()
        rows = self.client.get("/api/tasks/").json()
        row = rows[0] if isinstance(rows, list) else rows["results"][0]
        self.assertNotIn("due_date", row)
        self.assertIn("created_at", row)
        self.assertIn("source_label", row)

    def test_a_task_can_still_be_created_by_hand_and_a_due_date_in_the_request_is_ignored(self):
        resp = self.client.post("/api/tasks/", {"topic": self.topic.id, "title": "Call Priya", "due_date": "2026-10-31"}, format="json")
        self.assertEqual(resp.status_code, 201)
        self.assertIsNone(Task.objects.get(title="Call Priya").due_date)

    def test_source_of_a_task_added_by_hand(self):
        task = self.make_task()
        data = self.client.get(f"/api/tasks/{task.id}/source/").json()
        self.assertEqual(data, {"added_by_hand": True, "file": None, "passage": None})

    def test_source_names_the_file_by_template_and_real_name_and_quotes_the_passage(self):
        text = (
            "Ayush Sinha A   0:10\nWe agreed the pricing is fine.\n\n"
            "Siddharth Subramanian   0:42\nAyush will send the revised proposal to the client by Friday.\n\n"
            "Ayush Sinha A   1:05\nGreat, thanks everyone.\n"
        )
        f = make_file(self.topic, "kickoff-final.txt", text, doc_type="meeting_transcript", doc_type_source="llm")
        task = self.make_task(source_file=f)
        data = self.client.get(f"/api/tasks/{task.id}/source/").json()
        self.assertFalse(data["added_by_hand"])
        self.assertEqual(data["file"]["id"], f.id)
        self.assertEqual(data["file"]["name"], "kickoff-final.txt")
        self.assertEqual(data["file"]["label"], doc_meta.display_title(f))
        self.assertTrue(data["file"]["read_by_ai"])
        self.assertIn("revised proposal", data["passage"]["text"])
        self.assertEqual(data["passage"]["speaker"], "Siddharth Subramanian")

    def test_source_has_no_passage_when_nothing_in_the_file_matches(self):
        f = make_file(self.topic, "notes.txt", "Completely unrelated words about weather and lunch plans today.")
        task = self.make_task(source_file=f, title="Negotiate renewal pricing with procurement")
        data = self.client.get(f"/api/tasks/{task.id}/source/").json()
        self.assertEqual(data["file"]["id"], f.id)
        self.assertIsNone(data["passage"])

    def test_the_calendar_shows_meetings_and_no_task_dates(self):
        self.make_task()
        f = make_file(self.topic, "m.txt", "x")
        ExtractedMeta.objects.create(ingested_file=f, meeting_title="Kickoff", meeting_date=date(2026, 10, 7))
        rows = self.client.get("/api/calendar/").json()
        self.assertTrue(rows)
        self.assertNotIn("task", {r.get("kind") for r in rows})

    def test_the_task_endpoints_need_a_login(self):
        task = self.make_task()
        self.assertIn(APIClient().get(f"/api/tasks/{task.id}/source/").status_code, (401, 403))


class EvidencePassageTests(TestCase):
    def test_finds_the_best_matching_line_in_a_timestamped_transcript(self):
        text = "[00:10] The weather is nice today.\n[00:20] Ayush will send the revised proposal by Friday.\n[00:30] Thanks all."
        found = evidence.find_supporting_passage(text, "Send the revised proposal")
        self.assertIn("revised proposal", found["text"])
        self.assertEqual(found["ts"], "00:20")

    def test_returns_none_instead_of_guessing(self):
        self.assertIsNone(evidence.find_supporting_passage("Nothing relevant here at all.", "Negotiate renewal pricing"))

    def test_returns_none_for_a_title_too_short_to_match_on(self):
        self.assertIsNone(evidence.find_supporting_passage("Send it now please.", "Send"))

    def test_long_passages_are_clipped(self):
        long_line = "Revised proposal " + "word " * 300
        found = evidence.find_supporting_passage(long_line, "Revised proposal word")
        self.assertLessEqual(len(found["text"]), evidence.MAX_PASSAGE_CHARS)


# ---------------------------------------------------------------------------
# One shared login + the settings password
# ---------------------------------------------------------------------------
TEST_SETTINGS_PASSWORD = "settings-pw-not-real"


@override_settings(SINGLE_LOGIN_USERNAME="user", SETTINGS_EDIT_PASSWORD=TEST_SETTINGS_PASSWORD)
class OneLoginTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        User.objects.create_user("user", password="login-pw-not-real")
        User.objects.create_user("someone-else", email="x@example.com", password="other-pw-not-real")

    def login(self, username, password):
        return self.client.post("/api/auth/login/", {"username": username, "password": password}, format="json")

    def test_the_one_login_can_sign_in(self):
        self.assertEqual(self.login("user", "login-pw-not-real").status_code, 200)

    def test_the_username_is_not_case_sensitive(self):
        self.assertEqual(self.login("USER", "login-pw-not-real").status_code, 200)

    def test_any_other_account_cannot_sign_in_even_with_the_right_password(self):
        resp = self.login("someone-else", "other-pw-not-real")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["error"], "Incorrect username or password.")

    def test_a_wrong_password_gets_the_same_message_as_an_unknown_account(self):
        wrong = self.login("user", "nope").json()
        unknown = self.login("nobody", "nope").json()
        self.assertEqual(wrong, unknown)

    def test_sign_up_is_switched_off(self):
        resp = self.client.post(
            "/api/auth/register/",
            {"username": "new", "email": "n@example.com", "password": "abcdef", "display_name": "N"},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)
        self.assertFalse(User.objects.filter(username="new").exists())

    def test_email_password_reset_is_switched_off(self):
        self.assertEqual(self.client.post("/api/auth/password_reset/request/", {"email": "x@example.com"}, format="json").status_code, 403)
        self.assertEqual(
            self.client.post("/api/auth/password_reset/confirm/", {"uid": "x", "token": "y", "new_password": "abcdef"}, format="json").status_code,
            403,
        )


@override_settings(SINGLE_LOGIN_USERNAME="user", SETTINGS_EDIT_PASSWORD=TEST_SETTINGS_PASSWORD)
class SettingsPasswordTests(TestCase):
    def setUp(self):
        self.client = api_client(User.objects.create_user("user", password="x-not-real"))

    def save(self, body=None, **extra):
        body = {"llm_model": "some/model", **(body or {})}
        return self.client.post("/api/settings/", body, format="json", **extra)

    def test_saving_without_the_password_is_refused_and_changes_nothing(self):
        resp = self.save({"llm_api_key": "sk-new-not-real"})
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json()["code"], "settings_password")
        self.assertEqual(Settings.get("llm_api_key", ""), "")
        self.assertEqual(Settings.get("llm_model", ""), "")

    def test_a_wrong_password_is_refused(self):
        self.assertEqual(self.save({"settings_password": "wrong"}).status_code, 403)
        self.assertEqual(Settings.get("llm_model", ""), "")

    def test_the_right_password_saves(self):
        resp = self.save({"settings_password": TEST_SETTINGS_PASSWORD, "llm_api_key": "sk-new-not-real"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(Settings.get("llm_model"), "some/model")
        self.assertEqual(Settings.get("llm_api_key"), "sk-new-not-real")

    def test_the_password_can_also_come_as_a_header(self):
        resp = self.save(HTTP_X_SETTINGS_PASSWORD=TEST_SETTINGS_PASSWORD)
        self.assertEqual(resp.status_code, 200)

    def test_the_password_itself_is_never_stored_as_a_setting(self):
        self.save({"settings_password": TEST_SETTINGS_PASSWORD})
        self.assertFalse(Settings.objects.filter(key="settings_password").exists())
        self.assertFalse(Settings.objects.filter(value=TEST_SETTINGS_PASSWORD).exists())

    def test_an_empty_configured_password_opens_nothing(self):
        with override_settings(SETTINGS_EDIT_PASSWORD=""):
            self.assertEqual(self.save({"settings_password": ""}).status_code, 403)
            self.assertEqual(self.save().status_code, 403)

    def test_unlock_check(self):
        self.assertEqual(self.client.post("/api/settings/unlock/", {"settings_password": "wrong"}, format="json").status_code, 403)
        self.assertEqual(self.client.post("/api/settings/unlock/", {}, format="json").status_code, 403)
        ok = self.client.post("/api/settings/unlock/", {"settings_password": TEST_SETTINGS_PASSWORD}, format="json")
        self.assertEqual((ok.status_code, ok.json()), (200, {"ok": True}))
        self.assertEqual(Settings.get("llm_model", ""), "")  # unlock saves nothing

    def test_unlock_needs_a_login_too(self):
        resp = APIClient().post("/api/settings/unlock/", {"settings_password": TEST_SETTINGS_PASSWORD}, format="json")
        self.assertIn(resp.status_code, (401, 403))
        self.assertNotIn("ok", resp.json())

    def test_reading_settings_still_works_and_never_shows_the_key(self):
        Settings.set("llm_api_key", "sk-stored-not-real")
        data = self.client.get("/api/settings/").json()
        self.assertTrue(data["llm_api_key_set"])
        self.assertEqual(data["llm_api_key"], "")
        self.assertNotIn("sk-stored-not-real", str(data))

    def test_connector_changes_need_the_same_password(self):
        self.assertEqual(self.client.post("/api/connectors/outlook/request/").status_code, 403)
        ok = self.client.post("/api/connectors/outlook/request/", {"settings_password": TEST_SETTINGS_PASSWORD}, format="json")
        self.assertEqual(ok.status_code, 200)

    def test_the_settings_table_is_not_in_the_django_admin(self):
        from django.contrib import admin

        from .models import Settings as SettingsModel

        self.assertNotIn(SettingsModel, admin.site._registry)


class ShippedConfigTests(TestCase):
    """The values in settings.py itself (no override). Only lengths are checked - the password is never printed."""

    def test_the_shipped_settings_password_is_set_and_not_trivial(self):
        from django.conf import settings as real

        if not real.SETTINGS_EDIT_PASSWORD:
            self.skipTest("No local settings password on this machine (orientme/local_secrets.py) - Settings stays locked.")
        self.assertGreaterEqual(len(real.SETTINGS_EDIT_PASSWORD), 10)

    def test_the_password_is_not_written_in_settings_py(self):
        """It lives in the git-ignored local_secrets.py, so it never reaches GitHub with the code."""
        import pathlib

        from django.conf import settings as real

        if not real.SETTINGS_EDIT_PASSWORD:
            self.skipTest("No local settings password on this machine.")
        source = (pathlib.Path(real.BASE_DIR) / "orientme" / "settings.py").read_text(encoding="utf-8")
        self.assertNotIn(real.SETTINGS_EDIT_PASSWORD, source)

    def test_the_shipped_single_login_is_the_user_account(self):
        from django.conf import settings as real

        self.assertEqual(real.SINGLE_LOGIN_USERNAME, "user")
