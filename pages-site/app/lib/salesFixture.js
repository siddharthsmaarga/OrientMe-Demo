// One fictional sales opportunity for the static demo (added 5 Oct 2026):
// a mid-size beverage brand exploring AI for pricing and trade-promotion
// analytics for the first time, tracked from intro call through two solution
// meetings to a Final proposal and quotation. Everything here is invented -
// company, people, figures and dates are fictional and nothing refers to a
// real customer. Dates are relative to "today" so the story always reads as
// recent, the same convention the other fixtures use.
//
// It exercises every additive feature: typed + sequenced meetings, Teams-style
// speaker turns, emails, Proposal V1/V2/Final + quotation, 1-2 line human
// notes after meetings, document types/tags/signals in a mix of generated /
// confirmed / corrected states, one unreadable (error) file, and a
// pre-written opportunity-style recap.

export const SALES_TOPIC_ID = 4;

// Teams-style transcript text from structured turns ("Name  m:ss" line, then
// the spoken text) - the same shape the real app's parser reads.
function teamsText(title, dateLabel, attendees, turns) {
  const head = `${title}\n${dateLabel}\nAttendees: ${attendees.join(", ")}\n`;
  return head + "\n" + turns.map(({ speaker: who, ts, text }) => `${who}  ${ts}\n${text}`).join("\n\n");
}

export function buildSalesTopic({ daysFromNow, isoDaysAgo }) {
  const T = SALES_TOPIC_ID;
  const customer = "Larkspur Beverages Co.";

  const topic = {
    id: T,
    name: "Larkspur Beverages - Pricing & Promo Analytics",
    topic_type: "opportunity",
    one_liner:
      "Account snapshot: Larkspur Beverages Co. is a mid-size beverage brand (about 40 SKUs, sold through three major retailers) that spends roughly 12% of revenue on trade promotions and has never used AI for pricing or promotion decisions.",
    related_people: "Meera Vasquez, Daniel Okoye, Hannah Brandt, Tomas Ferreira, Leah Fischer, Kiran Mehta",
    created_at: isoDaysAgo(64),
    stage: "solution",
    customer_name: customer,
  };

  const folders = [{ id: 4, topic: T, path: "C:\\Demo\\Larkspur Pricing", added_at: isoDaysAgo(63) }];

  // ---- Meetings -----------------------------------------------------------
  const m = (id, offset, time, type, seq, title, attendees, agenda, achieved, turns) => ({
    id,
    meeting_title: title,
    meeting_date: daysFromNow(offset),
    meeting_time: time,
    attendees,
    agenda,
    achieved,
    meeting_type: type,
    meeting_sequence: seq,
    meeting_type_source: "auto",
    speaker_turns: (turns || []).map(([speaker, ts, text]) => ({ speaker, ts, text })),
  });

  const introTurnsRaw = [
    "[00:05] Thanks for making the time, Meera. We were introduced through your trade marketing team, and I would like to understand where pricing and promotions sit on your priority list this year.",
    "[00:31] Honestly, it is top of the list. We are a mid-size beverage brand, around forty SKUs, and every promotion decision still lives in spreadsheets and gut feel.",
    "[01:02] We have never used AI for pricing or trade promotions, so we are exploring what is realistic before we commit any budget.",
    "[01:40] That is a fair place to start. Our suggestion is a few short working sessions to understand your data and your questions, then a small pilot rather than a big programme.",
    "[02:15] A small pilot sounds right. Please set up the discovery sessions with Daniel from trade marketing and Hannah from finance.",
    "[02:40] Will do, I will send a follow-up with proposed dates today.",
  ];

  const metas = {
    intro: m(101, -62, "10:00 AM", "intro", 1, "Larkspur - Intro call", ["Meera Vasquez", "Leah Fischer", "Kiran Mehta"],
      "Understand where pricing and promotions sit on Larkspur's priorities.",
      "Larkspur has never used AI for pricing or promotions; agreed to a few discovery sessions and then a small pilot.",
      null),
    d1: m(102, -55, "11:00 AM", "discovery", 1, "Larkspur - Discovery 1: how promotions are planned today", ["Daniel Okoye", "Meera Vasquez", "Kiran Mehta", "Leah Fischer"],
      "Learn how promotions and pricing are planned and judged today.",
      "Promotions are planned quarterly in Excel; nobody can separate promotion lift from normal demand. Promotion payback is the first question, list pricing is phase two.",
      [
        ["Daniel Okoye", "0:12", "Today we plan promotions quarterly. Category managers build a calendar in Excel and we compare against last year's uplift manually."],
        ["Kiran Mehta", "0:48", "How do you know whether a discount actually paid back? Do you track baseline sales without promotion?"],
        ["Daniel Okoye", "1:15", "Not reliably. We see total sales for the promotion week, but we cannot separate the lift from normal demand or from a competitor's activity."],
        ["Meera Vasquez", "1:52", "That is the gap. We spend close to twelve percent of revenue on trade promotions and cannot say which ones work."],
        ["Leah Fischer", "2:30", "So the headline question is which promotions pay back, by retailer and by SKU. Is pricing itself, like list price changes, in scope as well?"],
        ["Meera Vasquez", "2:58", "Pricing is phase two. Promotion effectiveness first, because that is where the money leaks."],
      ]),
    d2: m(103, -47, "2:00 PM", "discovery", 2, "Larkspur - Discovery 2: data sources", ["Daniel Okoye", "Tomas Ferreira", "Kiran Mehta", "Leah Fischer"],
      "Map where shipment, sell-through and promotion-calendar data live.",
      "Three data sources identified; a pilot needs two years of weekly history for the top three retailers and no direct ERP access.",
      [
        ["Kiran Mehta", "0:10", "Walk us through where the numbers live: shipments, retailer sell-through, and the promotion calendar."],
        ["Tomas Ferreira", "0:42", "Shipments are in our ERP and we can export weekly. Retailer sell-through arrives as emailed files from three major retailers, in different formats."],
        ["Daniel Okoye", "1:20", "The promotion calendar is an Excel workbook. Each category manager keeps their own copy, so naming is inconsistent."],
        ["Kiran Mehta", "1:55", "For a pilot we only need two years of weekly history for the top three retailers. We would not touch the ERP directly."],
        ["Tomas Ferreira", "2:25", "Good, that keeps security simple. I will need to know exactly which fields you want before I can approve anything."],
        ["Leah Fischer", "2:50", "We will send a one-page data checklist after this call."],
      ]),
    d3: m(104, -39, "3:30 PM", "discovery", 3, "Larkspur - Discovery 3: success measures", ["Meera Vasquez", "Hannah Brandt", "Tomas Ferreira", "Kiran Mehta", "Leah Fischer"],
      "Agree what success looks like and the commercial guardrails.",
      "Success = promotion payback by retailer, forecast error on promoted weeks, time saved. Finance wants a fixed pilot price; IT requires in-country data hosting.",
      [
        ["Hannah Brandt", "0:08", "Before we go further, finance needs to know what success looks like. A model that is clever but cannot be audited will not get through my review."],
        ["Kiran Mehta", "0:40", "Agreed. We would propose three measures: promotion payback by retailer, forecast error on promoted weeks, and time saved in building the quarterly plan."],
        ["Meera Vasquez", "1:18", "Time saved matters less to me than money saved. If we find even two percent of trade spend that is wasted, the pilot has paid for itself."],
        ["Hannah Brandt", "1:55", "I would also want a fixed price for the pilot. Open-ended time and materials makes budgeting hard for us."],
        ["Tomas Ferreira", "2:20", "And data must stay in our region. Our policy is that retailer data cannot leave the country."],
        ["Leah Fischer", "2:48", "Understood on both. We will reflect fixed pricing and data residency in the proposal."],
      ]),
    s1: m(105, -30, "10:30 AM", "solution", 1, "Larkspur - Solution 1: pilot approach", ["Meera Vasquez", "Daniel Okoye", "Hannah Brandt", "Kiran Mehta", "Leah Fischer"],
      "Walk through the proposed six week pilot.",
      "Six week pilot on the top three retailers (promotion payback + baseline demand); no automatic commitment after the pilot; Meera wants other retailers as an optional phase.",
      [
        ["Kiran Mehta", "0:10", "Based on the three discovery sessions, we propose a six week pilot on the top three retailers, covering promotion payback analysis and a baseline demand view."],
        ["Daniel Okoye", "0:55", "Will category managers see results in something they already use, or is it another tool to log into?"],
        ["Kiran Mehta", "1:20", "A simple weekly report and a dashboard. No new logins for the first phase; we will refine this with you."],
        ["Hannah Brandt", "1:58", "What happens after six weeks? I do not want a surprise commitment."],
        ["Leah Fischer", "2:25", "Nothing is automatic. At the end we review results together and you decide on phase two, with its own price."],
        ["Meera Vasquez", "2:50", "I like it. Send the proposal and include the other retailers as an optional phase."],
      ]),
    s2: m(106, -21, "1:00 PM", "solution", 2, "Larkspur - Solution 2: proposal V1 feedback", ["Meera Vasquez", "Hannah Brandt", "Tomas Ferreira", "Kiran Mehta", "Leah Fischer"],
      "Review feedback on Proposal V1.",
      "Finance wants a fixed fee, IT wants a data-handling section, Meera wants the optional phase 2 visible, Finance wants a 30-day exit clause. V2 to be turned around this week.",
      [
        ["Hannah Brandt", "0:08", "I reviewed version one. The pricing is time and materials, which we said we cannot approve. Can it be a fixed fee for the pilot?"],
        ["Leah Fischer", "0:40", "Yes, version two will carry a fixed fee for the six week scope, with a clear change process if scope moves."],
        ["Tomas Ferreira", "1:12", "The data residency section is missing. I need hosting location and who can access the data written down."],
        ["Kiran Mehta", "1:45", "We will add a data handling section: in-country hosting, named access only, deletion at the end of the pilot."],
        ["Meera Vasquez", "2:15", "Also add the optional second phase for the remaining retailers so the board can see the full picture."],
        ["Hannah Brandt", "2:42", "And a thirty day exit clause, please, if the pilot is not delivering."],
        ["Leah Fischer", "3:05", "Noted. We will turn version two around this week."],
      ]),
  };

  // ---- Files --------------------------------------------------------------
  const base = (id, offset, path, extra) => ({
    id,
    topic: T,
    path,
    display_name: path.split("/").pop(),
    source_method: "folder",
    content_hash: `demo${id}`,
    extraction_error: "",
    first_added_at: isoDaysAgo(offset),
    last_ingested_at: isoDaysAgo(offset),
    meta: null,
    doc_type_source: "auto",
    meta_seconds: 0.1,
    review_notes: "",
    ...extra,
  });

  const meetingFile = (meta, path, state, tags, signal, extra = {}) =>
    base(meta.id, -daysOffset(meta.meeting_date), path, {
      meta,
      extracted_text: meta.speaker_turns.length
        ? teamsText(meta.meeting_title, meta.meeting_date, meta.attendees, meta.speaker_turns)
        : `${meta.meeting_title}\n${meta.meeting_date}\n\n` + introTurnsRaw.join("\n"),
      doc_type: "meeting_transcript",
      topic_tags: tags,
      signal,
      meta_state: state,
      document_date: null,
      version_label: "",
      ...extra,
    });

  function daysOffset(isoDate) {
    // positive "days ago" for first_added_at
    return Math.round((new Date(isoDate + "T00:00:00") - new Date(daysFromNow(0) + "T00:00:00")) / 86400000);
  }

  const email = (id, offset, file, subject, from, to, body, state, tags, signal, extra = {}) =>
    base(id, -offset, `emails/${file}`, {
      extracted_text: `From: ${from}\nTo: ${to.join(", ")}\nSubject: ${subject}\nDate: ${daysFromNow(offset)}\n\n${body}`,
      doc_type: "email",
      topic_tags: tags,
      signal,
      meta_state: state,
      document_date: daysFromNow(offset),
      version_label: "",
      subject,
      participants: [from, ...to],
      ...extra,
    });

  const files = [
    meetingFile(metas.intro, "transcripts/Larkspur_Intro_Call.docx", "confirmed", "Relationship",
      "Larkspur has never used AI for pricing or promotions and wants a small pilot after a few discovery sessions.",
      { review_notes: "Checked against my own notes from the call." }),
    meetingFile(metas.d1, "transcripts/Larkspur_Discovery_1.docx", "generated_unconfirmed", "Requirements, Commercial",
      "Promotions are planned in Excel and nobody can separate lift from normal demand; promotion payback is the first question."),
    meetingFile(metas.d2, "transcripts/Larkspur_Discovery_2.docx", "generated_unconfirmed", "Requirements, Stakeholders",
      "Shipments sit in the ERP, sell-through arrives as emailed retailer files, the promotion calendar is a per-manager Excel workbook."),
    meetingFile(metas.d3, "transcripts/Larkspur_Discovery_3.docx", "corrected", "Commercial, Risks, Decisions",
      "Success is measured by promotion payback, forecast error and time saved; Finance wants a fixed price and IT requires in-country data hosting.",
      { review_notes: "Added the Decisions tag - fixed price was agreed in this call." }),
    meetingFile(metas.s1, "transcripts/Larkspur_Solution_1.docx", "generated_unconfirmed", "Solution, Next Steps",
      "Six week pilot on the top three retailers with a weekly report and dashboard; no automatic commitment afterwards."),
    meetingFile(metas.s2, "transcripts/Larkspur_Solution_2.docx", "generated_unconfirmed", "Commercial, Risks, Decisions",
      "Feedback on V1: fixed fee, data-handling section, optional phase 2 and a 30-day exit clause."),

    email(111, -61, "2026-intro_follow-up_and_discovery_dates.eml", "Intro follow-up and proposed discovery dates",
      "Leah Fischer", ["Meera Vasquez"],
      "Hi Meera,\n\nThank you for the conversation yesterday. As discussed, I have pencilled three short discovery sessions over the next three weeks: how promotions are planned today, where the data lives, and what success should look like. Daniel and Hannah are invited where relevant.\n\nPlease tell me if any slot clashes with your quarter-end planning.\n\nRegards,\nLeah",
      "generated_unconfirmed", "Relationship, Next Steps",
      "Intro follow-up: three discovery sessions proposed (planning today, data sources, success measures)."),
    email(112, -54, "2026-promo_calendar_attached.eml", "Thanks - sample promotion calendar attached",
      "Daniel Okoye", ["Leah Fischer"],
      "Hi Leah,\n\nThanks for the session yesterday. I have attached last quarter's promotion calendar so Kiran can see the structure. Please note each category manager keeps their own copy, so column names differ a little.\n\nDaniel",
      "generated_unconfirmed", "Requirements",
      "Daniel shared last quarter's promotion calendar; column names differ by category manager."),
    email(113, -44, "2026-data_access_checklist.eml", "Data access for the pilot - IT checklist",
      "Tomas Ferreira", ["Kiran Mehta", "Leah Fischer"],
      "Hi both,\n\nThe data checklist is fine in principle. Two conditions from IT: the data stays hosted inside the country, and access is limited to named people. Please confirm both in writing before we export anything.\n\nTomas",
      "generated_unconfirmed", "Risks, Requirements",
      "IT accepts the data checklist on two conditions: in-country hosting and named-only access."),
    email(114, -29, "2026-feedback_after_solution_1.eml", "Feedback after Solution 1",
      "Meera Vasquez", ["Leah Fischer"],
      "Leah,\n\nGood session. Three things for the proposal: a fixed price for the pilot (Hannah will insist), the other retailers as an optional phase, and something on data residency so Tomas is comfortable.\n\nMeera",
      "corrected", "Commercial, Solution",
      "Meera asks for a fixed pilot price, an optional phase for other retailers, and a data-residency section.",
      { review_notes: "Tags corrected: this is the source of the V2 changes." }),
    email(115, -17, "2026-re_proposal_v2_finance_questions.eml", "Re: Proposal V2 - finance questions",
      "Hannah Brandt", ["Leah Fischer", "Kiran Mehta"],
      "Leah, Kiran,\n\nV2 is much closer. Two questions: what happens to the fee if we pause after week three, and can the exit clause be thirty days rather than sixty? Please reflect the answers in the final version.\n\nHannah",
      "generated_unconfirmed", "Commercial, Risks",
      "Hannah is close to approving V2 but wants a 30-day exit and clarity on pausing the pilot."),
    email(116, -7, "2026-final_proposal_and_quote.eml", "Final proposal and quotation - approval path",
      "Leah Fischer", ["Meera Vasquez", "Hannah Brandt"],
      "Hi Meera, Hannah,\n\nAttached are the Final proposal and the quotation. The Final version adds the 30-day exit clause Hannah asked for and keeps the fixed fee. If you are comfortable, the next step is Hannah's sign-off and a start date.\n\nLeah",
      "generated_unconfirmed", "Commercial, Next Steps",
      "Final proposal and quotation sent; next step is Finance sign-off and a start date."),

    base(121, 45, "notes/Pricing_Data_Notes.txt", {
      source_method: "paste",
      extracted_text: "Pricing data notes\n\nWeekly shipments are available per SKU from the ERP. Sell-through from the three retailers arrives in three different file layouts. The promotion calendar has no unique promotion id, so promotions have to be matched by retailer, SKU and start week.",
      doc_type: "notes",
      topic_tags: "Requirements",
      signal: "Data notes: three sell-through layouts and no unique promotion id, so promotions are matched by retailer, SKU and start week.",
      meta_state: "generated_unconfirmed",
      document_date: daysFromNow(-45),
      version_label: "",
    }),
    base(122, 44, "data/Larkspur_Promo_Calendar_2026.xlsx", {
      extracted_text: "",
      extraction_error: "Could not read this workbook - it is password-protected. Ask the owner for an unprotected copy.",
      doc_type: "other",
      topic_tags: "",
      signal: "",
      meta_state: "error",
      document_date: null,
      version_label: "",
      review_notes: "",
    }),

    base(131, 27, "proposals/Larkspur_Proposal_V1.docx", {
      extracted_text:
        "Larkspur Beverages - Pricing and Promotion Analytics Pilot (V1)\n\nScope: six week pilot on the top three retailers covering promotion payback analysis and a baseline demand view.\nApproach: weekly report and a dashboard; no new logins in the first phase.\nPricing: time and materials, estimated eight weeks at the agreed rate card.\nNext step: review at the end of the pilot; phase two is a separate decision.",
      doc_type: "proposal",
      topic_tags: "Solution, Commercial",
      signal: "V1 proposes a six week pilot on the top three retailers (promotion payback and baseline demand), priced time and materials.",
      meta_state: "confirmed",
      document_date: daysFromNow(-27),
      version_label: "V1",
    }),
    base(132, 18, "proposals/Larkspur_Proposal_V2.docx", {
      extracted_text:
        "Larkspur Beverages - Pricing and Promotion Analytics Pilot (V2)\n\nChanges from V1, based on Solution 2 feedback:\n- Pricing moved from time and materials to a fixed fee for the six week scope (requested by Finance).\n- New data handling section: in-country hosting, named access only, deletion at the end of the pilot (requested by IT).\n- Optional phase 2 for the remaining retailers added (requested by Meera).",
      doc_type: "proposal",
      topic_tags: "Solution, Commercial, Risks",
      signal: "V2 moves pricing to a fixed fee, adds a data handling section and an optional phase 2, all from the Solution 2 feedback.",
      meta_state: "corrected",
      document_date: daysFromNow(-18),
      version_label: "V2",
      review_notes: "Version label fixed to V2; checked the fee against the quotation draft.",
    }),
    base(133, 9, "proposals/Larkspur_Proposal_Final.docx", {
      extracted_text:
        "Larkspur Beverages - Pricing and Promotion Analytics Pilot (Final)\n\nChanges from V2, based on Hannah Brandt's email:\n- Exit clause set to 30 days (V2 had 60).\n- Clarified that pausing after week three stops further fees for the paused weeks.\n- Fixed fee, data handling section and optional phase 2 unchanged.",
      doc_type: "proposal",
      topic_tags: "Commercial, Decisions",
      signal: "Final adds the 30-day exit clause and pause terms Finance asked for; fixed fee and data handling are unchanged from V2.",
      meta_state: "generated_unconfirmed",
      document_date: daysFromNow(-9),
      version_label: "Final",
    }),
    base(134, 8, "proposals/Larkspur_Quotation.xlsx", {
      extracted_text:
        "Quotation - Larkspur Beverages Co.\n\nPilot (six weeks, fixed fee): USD 48,000\nOptional phase 2 (remaining retailers, ten weeks): USD 72,000\nPayment terms: 50 percent at start, 50 percent at pilot review.\nValid for 30 days from the date of issue.",
      doc_type: "quotation_sow",
      topic_tags: "Commercial",
      signal: "Quotation: fixed fee of USD 48,000 for the pilot and an optional USD 72,000 phase 2, valid for 30 days.",
      meta_state: "generated_unconfirmed",
      document_date: daysFromNow(-8),
      version_label: "",
    }),
  ];

  // ---- Human notes (1-2 lines, written by a person right after a meeting) --
  const notes = [
    { id: 1, topic: T, meta: 101, text: "Meera is the sponsor and is genuinely curious but cautious on budget. Keep it small.", author: "demo", created_at: isoDaysAgo(62) },
    { id: 2, topic: T, meta: 102, text: "Daniel is a champion - he is tired of the Excel process. Promotion payback is the hook.", author: "demo", created_at: isoDaysAgo(55) },
    { id: 3, topic: T, meta: 104, text: "Hannah (Finance) is the real gatekeeper. Fixed price and an audit trail will decide this.", author: "demo", created_at: isoDaysAgo(39) },
    { id: 4, topic: T, meta: 105, text: "Strong reaction to 'no commitment after six weeks'. Proposal must show phase 2 as optional.", author: "demo", created_at: isoDaysAgo(30) },
    { id: 5, topic: T, meta: 106, text: "All four asks are small and fair - expect to close if V2 lands this week.", author: "demo", created_at: isoDaysAgo(21) },
  ];

  // ---- Work items ---------------------------------------------------------
  const ts = (o) => isoDaysAgo(o);
  const tasks = [
    { id: 11, topic: T, source_file: 106, title: "Send Larkspur the Final proposal and quotation", assignee: "Leah Fischer", due_date: daysFromNow(-7), status: "done", created_at: ts(12), updated_at: ts(7) },
    { id: 12, topic: T, source_file: null, title: "Confirm the pilot start date with Meera once Finance signs off", assignee: "Leah Fischer", due_date: daysFromNow(3), status: "backlog", created_at: ts(6), updated_at: ts(6) },
    { id: 13, topic: T, source_file: 103, title: "Collect two years of weekly sell-through for the top three retailers", assignee: "Tomas Ferreira", due_date: daysFromNow(7), status: "in_progress", created_at: ts(20), updated_at: ts(3) },
    { id: 14, topic: T, source_file: 113, title: "Answer IT's data-handling questionnaire in writing", assignee: "Kiran Mehta", due_date: daysFromNow(2), status: "in_progress", created_at: ts(15), updated_at: ts(2) },
  ];
  const commitments = [
    { id: 11, topic: T, source_file: 106, linked_task: 11, person: "Leah Fischer", commitment: "Turn Proposal V2 around within the week, with a fixed fee and a data handling section.", date_made: daysFromNow(-21), due_date: daysFromNow(-14), status: "done", created_at: ts(21) },
    { id: 12, topic: T, source_file: 115, linked_task: null, person: "Kiran Mehta", commitment: "Share an anonymised sample promotion payback report so Finance can see the audit trail.", date_made: daysFromNow(-17), due_date: daysFromNow(4), status: "open", created_at: ts(17) },
  ];
  const decisions = [
    { id: 11, topic: T, source_file: 104, decision: "The pilot is priced as a fixed fee, not time and materials.", context: "Finance cannot approve open-ended pricing; agreed in Discovery 3 and confirmed in Solution 2.", participants: "Hannah Brandt, Leah Fischer", decided_date: daysFromNow(-39), status: "decided", created_at: ts(39) },
    { id: 12, topic: T, source_file: 102, decision: "Phase 1 covers promotion payback only; list pricing is phase 2.", context: "Meera: that is where the money leaks, so start there.", participants: "Meera Vasquez, Kiran Mehta", decided_date: daysFromNow(-55), status: "decided", created_at: ts(55) },
  ];
  const risks = [
    { id: 11, topic: T, source_file: null, description: "Finance sign-off is still pending and Hannah's budget cycle closes at month end.", impact: "A missed cycle could push the pilot start by a quarter.", owner: "Leah Fischer", status: "open", created_at: ts(6) },
    { id: 12, topic: T, source_file: 103, description: "Retailer sell-through arrives in three file layouts and the promotion calendar has no unique id.", impact: "Data cleaning could eat into the six week pilot.", owner: "Kiran Mehta", status: "open", created_at: ts(30) },
  ];

  // ---- Pre-written opportunity-style recap (the demo's existing brief shape)
  const summaries = [
    {
      id: 11,
      topic: T,
      answer_summary:
        "Opportunity: Larkspur wants to learn which of its trade promotions pay back, starting with a six week, fixed-fee pilot on its top three retailers. It is their first use of AI for pricing or promotion decisions. The Final proposal and quotation were sent a week ago and the deal now waits on Finance sign-off.",
      why_now: "Get the Final proposal and quotation approved by Larkspur Finance before their month-end budget cycle closes.",
      current_state:
        "- Proposal and commercial status: V1 (time and materials) went out after Solution 1; V2 (fixed fee, data handling, optional phase 2) followed Solution 2; Final adds the 30-day exit clause Finance asked for.\n- Quotation: USD 48,000 fixed fee for the six week pilot, optional USD 72,000 phase 2, valid for 30 days.\n- Larkspur is close to approval; Hannah Brandt (Finance) is the last gate.",
      history:
        "- Intro (call 1): never used AI for pricing; agreed to discovery sessions then a small pilot.\n- Discovery 1: promotions planned in Excel; no way to separate lift from normal demand; promotion payback first, list pricing later.\n- Discovery 2: three data sources mapped; pilot needs two years of weekly history, no direct ERP access.\n- Discovery 3: success measures agreed; Finance wants a fixed price, IT wants in-country hosting.\n- Solution 1: six week pilot walked through; no automatic commitment afterwards.\n- Solution 2: V1 feedback - fixed fee, data handling section, optional phase 2, 30-day exit.",
      customer_thoughts:
        "- Meera Vasquez, VP Revenue Growth - sponsor; supportive, cautious on budget.\n- Daniel Okoye, Head of Trade Marketing - champion; wants to leave the Excel process behind.\n- Hannah Brandt, Director of Finance - gatekeeper; supportive if fixed price and audit trail are clear.\n- Tomas Ferreira, IT Data Platform Lead - neutral; approves only with in-country hosting and named access.",
      customer_need:
        "- Learn which trade promotions pay back, by retailer and by SKU (about 12% of revenue goes to trade promotions).\n- Scope: promotion payback analysis and a baseline demand view for the top three retailers; list pricing is phase 2.\n- Stakeholder - Meera Vasquez (VP Revenue Growth): sponsor, supportive, cautious on budget.\n- Stakeholder - Daniel Okoye (Head of Trade Marketing): champion.\n- Stakeholder - Hannah Brandt (Director of Finance): gatekeeper, wants fixed price and auditability.\n- Stakeholder - Tomas Ferreira (IT Data Platform Lead): neutral, security conditions.",
      proposed_solution:
        "- Six week pilot on the top three retailers with a weekly report and dashboard.\n- Proposal V1 (time and materials) -> V2 (fixed fee, data handling, optional phase 2) -> Final (30-day exit clause, pause terms).\n- Optional phase 2 for the remaining retailers is priced separately.",
      latest_updates:
        "- Intro, 1 call, then Discovery 1-3 and Solution 1-2, all in date order across the last nine weeks.\n- Proposal V1 -> V2 -> Final and the quotation were each derived directly from meeting and email feedback.\n- Final proposal and quotation sent 7-9 days ago.",
      decisions_made: "- Pilot is a fixed fee, not time and materials.\n- Phase 1 covers promotion payback only.",
      meeting_prep: "",
      promises_made:
        "- Open item: Hannah Brandt / Finance sign-off on the Final proposal.\n- Open item: Kiran Mehta to share an anonymised sample payback report.\n- Open item: Tomas Ferreira to supply two years of weekly sell-through.",
      next_step: "- Confirm Finance sign-off and agree a pilot start date with Meera Vasquez.\n- Send the anonymised sample payback report to Hannah.",
      risks_and_gaps:
        "- Finance sign-off is pending and the budget cycle closes at month end.\n- Sell-through data arrives in three layouts; cleaning could eat into the six weeks.",
      sources_used: [
        "Larkspur_Proposal_Final.docx",
        "Larkspur_Quotation.xlsx",
        "Larkspur_Solution_2.docx",
        "2026-final_proposal_and_quote.eml",
      ],
      field_sources: {
        current_state: ["Larkspur_Proposal_Final.docx", "Larkspur_Quotation.xlsx"],
        next_step: ["2026-final_proposal_and_quote.eml"],
        risks_and_gaps: ["Larkspur_Solution_2.docx"],
      },
      generated_at: isoDaysAgo(2),
      is_manual_edit: false,
    },
  ];

  const projectState = {
    id: 11,
    topic: T,
    current_position:
      "Final proposal and quotation are with Larkspur. Sponsor is supportive; Finance sign-off is the only thing between us and a six week pilot start.",
    previous_position: "V2 sent after Solution 2; Finance still had two questions on the exit clause.",
    updated_at: isoDaysAgo(2),
    updated_by: "Demo Admin",
  };

  return { topic, folders, files, notes, tasks, commitments, decisions, risks, summaries, projectState };
}
