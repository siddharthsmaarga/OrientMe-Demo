// Demo dataset for the standalone (no-backend) build of this frontend.
// Everything here is fictional - no real project or people names or
// content. This module owns a single in-memory "store" that api.js reads
// and mutates; reloading the page resets it back to this initial shape
// (nothing here persists across a real page reload - intentional for a
// public demo, see api.js's own header comment).

let nextId = 1000;
export function newId() {
  return nextId++;
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

export const DEMO_USER = {
  authenticated: true,
  username: "demo",
  display_name: "Demo Admin",
  role: "admin",
};

function buildInitialState() {
  const topics = [
    {
      id: 1,
      name: "Acme Rebrand",
      topic_type: "project",
      one_liner: "Refreshing Acme's brand identity across the website and product surfaces.",
      related_people: "Jordan Lee, Priya Nair, Sam Ortiz",
      created_at: isoDaysAgo(30),
    },
    {
      id: 2,
      name: "Meridian Onboarding",
      topic_type: "customer",
      one_liner: "Guiding Meridian through their first 90 days on the platform.",
      related_people: "Taylor Brooks, Morgan Diaz",
      created_at: isoDaysAgo(18),
    },
    {
      id: 3,
      name: "Payroll Ops Review",
      topic_type: "process",
      one_liner: "Monthly consolidated hours review before payroll runs.",
      related_people: "Priya Nair, Casey Kim",
      created_at: isoDaysAgo(45),
    },
  ];

  const folders = [{ id: 1, topic: 1, path: "C:\\Demo\\Acme Rebrand", added_at: isoDaysAgo(29) }];

  const files = [
    {
      id: 1,
      topic: 1,
      path: "Acme Kickoff Meeting.txt",
      display_name: "Acme Kickoff Meeting.txt",
      source_method: "folder",
      content_hash: "demo1",
      extraction_error: "",
      first_added_at: isoDaysAgo(29),
      last_ingested_at: isoDaysAgo(29),
      meta: {
        id: 1,
        meeting_title: "Acme Rebrand Kickoff",
        meeting_date: daysFromNow(-26),
        meeting_time: "10:00 AM",
        attendees: ["Jordan Lee", "Priya Nair", "Sam Ortiz"],
        agenda: "Align on rebrand scope, timeline, and success metrics.",
        achieved: "Agreed on a phased rollout: web first, then product UI, then marketing collateral.",
      },
    },
    {
      id: 2,
      topic: 1,
      path: "Acme Design Review.txt",
      display_name: "Acme Design Review.txt",
      source_method: "folder",
      content_hash: "demo2",
      extraction_error: "",
      first_added_at: isoDaysAgo(12),
      last_ingested_at: isoDaysAgo(12),
      meta: {
        id: 2,
        meeting_title: "Acme Design Review — Round 1",
        meeting_date: daysFromNow(-10),
        meeting_time: "2:00 PM",
        attendees: ["Jordan Lee", "Sam Ortiz"],
        agenda: "Review the first homepage concept and logo lockup options.",
        achieved: "Picked the warm-neutral palette; asked for one more logo variant before sign-off.",
      },
    },
    {
      id: 3,
      topic: 1,
      path: "Brand Guidelines Draft.docx",
      display_name: "Brand Guidelines Draft.docx",
      source_method: "upload",
      content_hash: "demo3",
      extraction_error: "",
      first_added_at: isoDaysAgo(8),
      last_ingested_at: isoDaysAgo(8),
      meta: null,
    },
    {
      id: 4,
      topic: 2,
      path: "Meridian Onboarding Call.txt",
      display_name: "Meridian Onboarding Call.txt",
      source_method: "folder",
      content_hash: "demo4",
      extraction_error: "",
      first_added_at: isoDaysAgo(17),
      last_ingested_at: isoDaysAgo(17),
      meta: {
        id: 3,
        meeting_title: "Meridian Onboarding Call",
        meeting_date: daysFromNow(-16),
        meeting_time: "11:30 AM",
        attendees: ["Taylor Brooks", "Morgan Diaz"],
        agenda: "Walk through setup steps and confirm the success plan for the first quarter.",
        achieved: "Meridian confirmed their rollout timeline; flagged a data-import question to follow up on.",
      },
    },
  ];

  const tasks = [
    {
      id: 1,
      topic: 1,
      source_file: 1,
      title: "Draft the new homepage wireframe",
      assignee: "Sam Ortiz",
      due_date: daysFromNow(-2),
      status: "done",
      created_at: isoDaysAgo(26),
      updated_at: isoDaysAgo(3),
    },
    {
      id: 2,
      topic: 1,
      source_file: 2,
      title: "Produce one more logo lockup variant",
      assignee: "Jordan Lee",
      due_date: daysFromNow(-1),
      status: "in_progress",
      created_at: isoDaysAgo(10),
      updated_at: isoDaysAgo(1),
    },
    {
      id: 3,
      topic: 1,
      source_file: null,
      title: "Confirm the final color palette with legal (trademark check)",
      assignee: "Priya Nair",
      due_date: daysFromNow(2),
      status: "backlog",
      created_at: isoDaysAgo(6),
      updated_at: isoDaysAgo(6),
    },
    {
      id: 4,
      topic: 1,
      source_file: null,
      title: "Update the marketing site footer with the new wordmark",
      assignee: "Sam Ortiz",
      due_date: daysFromNow(9),
      status: "backlog",
      created_at: isoDaysAgo(4),
      updated_at: isoDaysAgo(4),
    },
    {
      id: 5,
      topic: 2,
      source_file: 4,
      title: "Resolve Meridian's data-import formatting question",
      assignee: "Morgan Diaz",
      due_date: daysFromNow(-3),
      status: "in_progress",
      created_at: isoDaysAgo(16),
      updated_at: isoDaysAgo(2),
    },
    {
      id: 6,
      topic: 2,
      source_file: null,
      title: "Schedule the 30-day check-in call",
      assignee: "Taylor Brooks",
      due_date: daysFromNow(5),
      status: "backlog",
      created_at: isoDaysAgo(5),
      updated_at: isoDaysAgo(5),
    },
  ];

  const commitments = [
    {
      id: 1,
      topic: 1,
      source_file: 1,
      linked_task: 2,
      person: "Jordan Lee",
      commitment: "Provide one more logo lockup variant before the next review.",
      date_made: daysFromNow(-10),
      due_date: daysFromNow(-1),
      status: "in_progress",
      created_at: isoDaysAgo(10),
    },
    {
      id: 2,
      topic: 2,
      source_file: 4,
      linked_task: null,
      person: "Morgan Diaz",
      commitment: "Send Meridian a corrected data-import template by end of week.",
      date_made: daysFromNow(-16),
      due_date: daysFromNow(-3),
      status: "open",
      created_at: isoDaysAgo(16),
    },
  ];

  const decisions = [
    {
      id: 1,
      topic: 1,
      source_file: 2,
      decision: "Use the warm-neutral palette (not the cool-gray option) for the rebrand.",
      context: "Tested better with the sample audience in the design review; matches Acme's existing product photography.",
      participants: "Jordan Lee, Sam Ortiz",
      decided_date: daysFromNow(-10),
      status: "decided",
      created_at: isoDaysAgo(10),
    },
    {
      id: 2,
      topic: 1,
      source_file: null,
      decision: "Ship the rebrand in three phases: web, then product UI, then marketing collateral.",
      context: "Reduces risk of a single big-bang launch; lets the team learn from the website rollout first.",
      participants: "Jordan Lee, Priya Nair, Sam Ortiz",
      decided_date: daysFromNow(-26),
      status: "decided",
      created_at: isoDaysAgo(26),
    },
  ];

  const risks = [
    {
      id: 1,
      topic: 1,
      source_file: null,
      description: "Trademark check on the new color palette hasn't been confirmed by legal yet.",
      impact: "Could force a late palette change after design work is already underway.",
      owner: "Priya Nair",
      status: "open",
      created_at: isoDaysAgo(6),
    },
    {
      id: 2,
      topic: 2,
      source_file: null,
      description: "Meridian's data-import format issue is still unresolved past its original due date.",
      impact: "Risks delaying their 30-day success milestone.",
      owner: "Morgan Diaz",
      status: "open",
      created_at: isoDaysAgo(3),
    },
  ];

  const summaries = [
    {
      id: 2,
      topic: 1,
      answer_summary: "The Acme rebrand is on track: palette and phased rollout are locked, one logo variant and a legal trademark check remain before design sign-off.",
      why_now: "",
      current_state:
        "- Homepage wireframe is done.\n- Warm-neutral palette and 3-phase rollout are decided.\n- One more logo lockup variant is in progress.",
      history: "",
      customer_thoughts: "",
      customer_need: "",
      proposed_solution: "",
      latest_updates: "",
      decisions_made: "",
      meeting_prep: "",
      promises_made: "- Jordan Lee: one more logo lockup variant (was due yesterday).",
      next_step: "- Get legal's trademark sign-off on the palette.\n- Finish the extra logo variant for review.",
      risks_and_gaps: "- Trademark check on the palette hasn't been confirmed by legal yet.",
      sources_used: ["Acme Kickoff Meeting.txt", "Acme Design Review.txt"],
      field_sources: {
        current_state: ["Acme Design Review.txt"],
        next_step: ["Acme Design Review.txt"],
        risks_and_gaps: ["Acme Design Review.txt"],
      },
      generated_at: isoDaysAgo(3),
      is_manual_edit: false,
    },
    {
      id: 1,
      topic: 1,
      answer_summary: "Kickoff complete — scope, timeline, and phased rollout agreed.",
      current_state: "- Kickoff meeting held; rebrand scope and phased rollout agreed.",
      why_now: "",
      history: "",
      customer_thoughts: "",
      customer_need: "",
      proposed_solution: "",
      latest_updates: "",
      decisions_made: "",
      meeting_prep: "",
      promises_made: "",
      next_step: "- Start homepage wireframe.",
      risks_and_gaps: "",
      sources_used: ["Acme Kickoff Meeting.txt"],
      field_sources: {},
      generated_at: isoDaysAgo(26),
      is_manual_edit: false,
    },
    {
      id: 3,
      topic: 2,
      answer_summary: "Meridian's onboarding is progressing; one open data-import question is overdue.",
      current_state: "- Onboarding call held, success plan confirmed for the first quarter.",
      why_now: "",
      history: "",
      customer_thoughts: "",
      customer_need: "",
      proposed_solution: "",
      latest_updates: "",
      decisions_made: "",
      meeting_prep: "",
      promises_made: "- Morgan Diaz: corrected data-import template (was due 3 days ago).",
      next_step: "- Resolve the data-import formatting question.\n- Schedule the 30-day check-in.",
      risks_and_gaps: "- Data-import issue is unresolved past its due date, risking the 30-day milestone.",
      sources_used: ["Meridian Onboarding Call.txt"],
      field_sources: {},
      generated_at: isoDaysAgo(2),
      is_manual_edit: false,
    },
  ];

  const projectStates = [
    {
      id: 1,
      topic: 1,
      current_position:
        "Design direction is locked (warm-neutral palette, phased rollout). We're finishing the last logo variant and waiting on legal's trademark sign-off before development starts on the new homepage.",
      previous_position: "Kickoff just wrapped — scope and timeline agreed, no design direction yet.",
      updated_at: isoDaysAgo(2),
      updated_by: "Demo Admin",
    },
  ];

  const messages = [
    {
      id: 1,
      topic: 1,
      role: "user",
      content: "Catch me up on this project — what's the current state and what's changed recently?",
      source_files: [],
      is_llm: false,
      generation_note: "",
      created_at: isoDaysAgo(3),
    },
    {
      id: 2,
      topic: 1,
      role: "assistant",
      content:
        "The Acme rebrand is on track: palette and phased rollout are locked, one logo variant and a legal trademark check remain before design sign-off.",
      source_files: [
        { id: 1, path: "Acme Kickoff Meeting.txt", display_name: "Acme Kickoff Meeting.txt", first_added_at: isoDaysAgo(29) },
        { id: 2, path: "Acme Design Review.txt", display_name: "Acme Design Review.txt", first_added_at: isoDaysAgo(12) },
      ],
      is_llm: false,
      generation_note: "Demo mode — this is a simulated answer, not a live model call.",
      created_at: isoDaysAgo(3),
    },
  ];

  const workflows = [
    {
      id: 1,
      topic: 3,
      workflow_type: "payroll_approval",
      status: "pending",
      computed_data: {
        month: new Date().toISOString().slice(0, 7),
        employees: [
          { name: "Priya Nair", total_hours: 38.5, entries: [{ hours: 38.5, date: null, date_unknown: true, source_file: "Payroll Ops Notes.txt" }] },
          { name: "Casey Kim", total_hours: 41, entries: [{ hours: 41, date: null, date_unknown: true, source_file: "Payroll Ops Notes.txt" }] },
        ],
      },
      created_at: isoDaysAgo(1),
      approved_at: null,
    },
  ];

  const connectors = [
    { slug: "slack", status: "not_connected", requested_at: null },
    { slug: "microsoftoutlook", status: "not_connected", requested_at: null },
    { slug: "googledrive", status: "not_connected", requested_at: null },
  ];

  // Sample data for the Transcripts page (the auto-watch recordings
  // pipeline) - illustrates all four real outcomes (routed, awaiting a
  // new-project decision, needs manual review, pre-existing/not processed)
  // without a live watcher, transcription engine, or LLM router behind it.
  // transcript_text is fictional sample content for the /transcripts/[id]
  // detail page; meeting_summary/summary_generated_at mirror the real app's
  // schema and start empty - a summary is only ever written by a person
  // clicking "Generate Summary" (see api.js's generateRecordingSummary),
  // never generated automatically.
  const recordingEvents = [
    {
      id: 1,
      file_path: "Acme Rebrand Weekly Sync-20260922_140000UTC-Meeting Recording.mp4",
      file_name: "Acme Rebrand Weekly Sync-20260922_140000UTC-Meeting Recording.mp4",
      detected_at: isoDaysAgo(7),
      topic: 1,
      topic_name: "Acme Rebrand",
      ingested_file: null,
      status: "routed",
      engine_used: "local_whisper",
      detail: "Matched - 'Acme Rebrand' is named directly in the transcript.",
      suggested_topic_name: "",
      suggested_topic_one_liner: "",
      suggested_topic_type: "",
      transcript_text:
        "Jordan Lee: Quick update from my side — the extra logo lockup variant is basically done, I'll drop it in the shared folder tonight.\nPriya Nair: Good, because design sign-off is blocked on it. Any word from legal on the trademark check for the warm-neutral palette?\nJordan Lee: Not yet. I followed up again yesterday.\nSam Ortiz: I can start wiring the new wordmark into the marketing site footer in parallel, that doesn't need to wait on legal.\nPriya Nair: Do that. I'll chase legal again today and flag it as blocking if I don't hear back by Friday.\nJordan Lee: Sounds good. Once the variant's in, we should be ready for the next design review.\nSam Ortiz: Agreed — let's target early next week for that.",
      meeting_summary: "",
      summary_generated_at: null,
    },
    {
      id: 2,
      file_path: "Meridian Onboarding Call 2-20260920_093000UTC-Meeting Recording.mp4",
      file_name: "Meridian Onboarding Call 2-20260920_093000UTC-Meeting Recording.mp4",
      detected_at: isoDaysAgo(9),
      topic: 2,
      topic_name: "Meridian Onboarding",
      ingested_file: null,
      status: "routed",
      engine_used: "local_whisper",
      detail: "Matched by LLM to an existing project.",
      suggested_topic_name: "",
      suggested_topic_one_liner: "",
      suggested_topic_type: "",
      transcript_text:
        "Taylor Brooks: Where are we on the data-import formatting issue? It's been open a few days past the original date.\nMorgan Diaz: Almost there — I found the root cause, a date field Meridian's export uses a different format than we expect. The corrected template is ready, I'll send it today.\nTaylor Brooks: Great, that'll unblock their import. Can we also lock the 30-day check-in call this week?\nMorgan Diaz: Yes, I'll send a few time options. Friday afternoon works on my end.\nTaylor Brooks: Friday works for me too. I'll loop in their team lead once we have a firm time.\nMorgan Diaz: Perfect, I'll follow up after I send the template.",
      meeting_summary: "",
      summary_generated_at: null,
    },
    {
      id: 3,
      file_path: "Vendor Security Review Kickoff-20260928_110000UTC-Meeting Recording.mp4",
      file_name: "Vendor Security Review Kickoff-20260928_110000UTC-Meeting Recording.mp4",
      detected_at: isoDaysAgo(1),
      topic: null,
      topic_name: "",
      ingested_file: null,
      status: "pending_new_project",
      engine_used: "local_whisper",
      detail: "Looks like a new project - review the suggested name and confirm or reject.",
      suggested_topic_name: "Q4 Vendor Security Review",
      suggested_topic_one_liner: "A one-time audit of third-party vendor access ahead of the Q4 compliance deadline.",
      suggested_topic_type: "project",
      transcript_text:
        "Dana Okafor: Thanks for jumping on short notice — we need to scope the Q4 vendor security review before the compliance deadline.\nRiley Chen: From procurement's side, we've got twelve active vendors with system access that haven't been re-reviewed this year.\nCasey Lindqvist: IT can pull access logs for all twelve, but we should prioritize the ones with write access to production data first.\nDana Okafor: Agreed. Let's treat this as its own project rather than folding it into an existing one — it has a hard deadline and a distinct scope.\nRiley Chen: Makes sense. I'll get the vendor list over to Casey by tomorrow.\nCasey Lindqvist: I'll start pulling logs as soon as I have it. Let's check back in a week.",
      meeting_summary: "",
      summary_generated_at: null,
    },
    {
      id: 4,
      file_path: "Coffee Chat with Alex-20260926_163000UTC-Meeting Recording.mp4",
      file_name: "Coffee Chat with Alex-20260926_163000UTC-Meeting Recording.mp4",
      detected_at: isoDaysAgo(3),
      topic: null,
      topic_name: "",
      ingested_file: null,
      status: "needs_review",
      engine_used: "local_whisper",
      detail: "No confident match, and not clearly a new project - needs manual assignment.",
      suggested_topic_name: "",
      suggested_topic_one_liner: "",
      suggested_topic_type: "",
      transcript_text:
        "Alex: Hey, good to catch up — it's been a while since we just talked without an agenda.\nDemo Admin: Yeah, things have been busy. How was the trip you mentioned last time?\nAlex: Really good, actually — took a few extra days off, barely looked at email.\nDemo Admin: Good, you needed that. Anything new on your end work-wise, or are we just talking weekend plans?\nAlex: Mostly just weekend plans, honestly — thinking about finally trying that new place downtown. Want to grab lunch sometime next week?\nDemo Admin: Sure, let's find a day. No real work topics here, just good to reconnect.",
      meeting_summary: "",
      summary_generated_at: null,
    },
    {
      id: 5,
      file_path: "Q2 All Hands-20260615_150000UTC-Meeting Recording.mp4",
      file_name: "Q2 All Hands-20260615_150000UTC-Meeting Recording.mp4",
      detected_at: isoDaysAgo(105),
      topic: null,
      topic_name: "",
      ingested_file: null,
      status: "pre_existing",
      engine_used: "",
      detail: "Existed before auto-watch was enabled - not auto-processed.",
      suggested_topic_name: "",
      suggested_topic_one_liner: "",
      suggested_topic_type: "",
      transcript_text:
        "CEO: Thanks everyone for joining the Q2 all-hands. Overall the quarter came in roughly on plan — revenue was up modestly versus Q1, and we closed a couple of the larger deals we'd been tracking.\nHead of Product: On the product side, the main roadmap items shipped close to schedule. We're prioritizing performance work next quarter based on customer feedback.\nHead of People: Hiring is on track against plan — a few open roles in engineering and support are still in process.\nCEO: Good to hear. Let's keep the momentum into Q3. Any questions from the floor before we wrap?\nEmployee: Just a quick one — will the roadmap doc be shared afterward?\nHead of Product: Yes, I'll post it right after this call.",
      meeting_summary: "",
      summary_generated_at: null,
    },
    {
      id: 6,
      file_path: "Founders Sync-20260601_090000UTC-Meeting Recording.mp4",
      file_name: "Founders Sync-20260601_090000UTC-Meeting Recording.mp4",
      detected_at: isoDaysAgo(119),
      topic: null,
      topic_name: "",
      ingested_file: null,
      status: "pre_existing",
      engine_used: "",
      detail: "Existed before auto-watch was enabled - not auto-processed.",
      suggested_topic_name: "",
      suggested_topic_one_liner: "",
      suggested_topic_type: "",
      transcript_text:
        "Founder A: Before we get into the roadmap, let's touch on the fundraising timeline — where do things stand?\nFounder B: A few conversations are progressing, nothing signed yet. I'd guess we're still a couple of months out from closing anything.\nFounder A: Okay, let's plan around that rather than counting on it landing sooner. On product, I think we should hold the line on the current roadmap rather than chasing the new feature request from last week.\nFounder B: Agreed — spreading thin this early would hurt more than it helps. Let's revisit priorities once we have more runway visibility.\nFounder A: Sounds right. Let's check back on both fronts in two weeks.",
      meeting_summary: "",
      summary_generated_at: null,
    },
  ];

  return {
    topics,
    folders,
    files,
    tasks,
    commitments,
    decisions,
    risks,
    summaries,
    projectStates,
    messages,
    workflows,
    loops: [],
    connectors,
    recordingEvents,
    settings: {
      llm_provider: "openrouter",
      llm_api_key_set: false,
      llm_model: "openai/gpt-5.4",
      llm_base_url: "https://openrouter.ai/api/v1",
      default_directory: "",
      stale_after_days: 14,
      // The Transcripts pipeline's own config (see settings/page.js's
      // "Transcripts" section) - fictional demo values, matching this
      // file's own "C:\Demo\..." convention used elsewhere, since there's
      // no real folder-watcher behind this static build (see
      // recordingEvents above and its own header comment).
      recordings_watch_folder: "C:\\Demo\\Recordings",
      recordings_suggest_new_topics: "true",
      transcription_engine: "local_whisper",
      external_transcription_url: "",
    },
    user: { ...DEMO_USER },
  };
}

export const store = buildInitialState();

export function resetStore() {
  Object.assign(store, buildInitialState());
}
