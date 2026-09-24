// Fictional sample records used by the static demo. The UI reads these in
// place of a server API so its existing dashboard and detail views stay
// interactive without implying access to real company data or AI services.

export const DEMO_TOPIC_ID = "demo";

const hoursAgo = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
const daysAgo = (days) => new Date(Date.now() - days * 86400_000).toISOString();
const dateDaysAgo = (days) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

const DEMO_ROOT = "/demo/harborline-logistics";

export const DEMO_FILES = [
  { id: 1, path: `${DEMO_ROOT}/planning-notes.txt`, display_name: "planning-notes.txt", source_method: "folder", first_added_at: daysAgo(1) },
  { id: 2, path: `${DEMO_ROOT}/forecast-review.docx`, display_name: "forecast-review.docx", source_method: "folder", first_added_at: daysAgo(2) },
  { id: 3, path: `${DEMO_ROOT}/route-options.md`, display_name: "route-options.md", source_method: "folder", first_added_at: daysAgo(3) },
  { id: 4, path: `${DEMO_ROOT}/team-sync.docx`, display_name: "team-sync.docx", source_method: "folder", first_added_at: daysAgo(4) },
];

export const DEMO_FOLDERS = [{ id: 1, path: DEMO_ROOT, added_at: daysAgo(7) }];

export const DEMO_TOPIC = {
  id: DEMO_TOPIC_ID,
  name: "Harborline Logistics - Delivery Planning",
  topic_type: "project",
  one_liner: "Explore practical ways to improve delivery planning and forecast visibility.",
  related_people: "Operations Lead, Data Team, Planning Team",
  created_at: daysAgo(14),
  folders: DEMO_FOLDERS,
  files: DEMO_FILES,
  file_count: DEMO_FILES.length,
  last_activity_at: hoursAgo(2),
  latest_risks_and_gaps: "- Sample data needs review before any real-world use\n- Forecast assumptions are still being checked",
  messages: [
    { id: 1, role: "user", content: "What is the current status?", created_at: daysAgo(3) },
    {
      id: 2,
      role: "assistant",
      content: "**Current state:** The team is reviewing delivery planning notes and comparing a few forecast approaches.",
      created_at: daysAgo(3),
      is_llm: false,
    },
    { id: 3, role: "user", content: "What is the next step?", created_at: daysAgo(1) },
    {
      id: 4,
      role: "assistant",
      content: "**Recommended next step:** Review the sample forecast with the Operations Lead and record any open assumptions.",
      created_at: daysAgo(1),
      is_llm: false,
    },
  ],
};

export const DEMO_SUMMARY = {
  id: 1,
  answer_summary: "The Harborline Logistics planning example is in review; the team is comparing delivery forecasts and documenting assumptions.",
  why_now: "Improve visibility into delivery plans using a small, reviewable sample.",
  current_state:
    "- Planning notes are being reviewed\n- The team is comparing forecast approaches\n- Assumptions need confirmation",
  history: "- The example began after a routine planning review\n- The Operations Team requested a clearer view of forecast assumptions",
  customer_thoughts: "- The sample team wants practical planning information that is easy to review",
  promises_made: "- Data Team to share a sample forecast\n- Operations Lead to confirm the review notes",
  next_step: "- Review the sample forecast\n- Record the assumptions that need confirmation",
  risks_and_gaps: "- Sample data needs review before any real-world use\n- Forecast assumptions are still being checked",
  sources_used: [`${DEMO_ROOT}/team-sync.docx`, `${DEMO_ROOT}/planning-notes.txt`],
  field_sources: {
    current_state: [`${DEMO_ROOT}/team-sync.docx`],
    next_step: [`${DEMO_ROOT}/team-sync.docx`],
    promises_made: [`${DEMO_ROOT}/planning-notes.txt`],
    risks_and_gaps: [`${DEMO_ROOT}/route-options.md`],
  },
  generated_at: hoursAgo(2),
  is_manual_edit: false,
};

export const DEMO_SUMMARY_HISTORY = [
  { ...DEMO_SUMMARY, id: 1, generated_at: daysAgo(5), timeline_title: "Planning review", timeline_body: "The team began comparing delivery forecast approaches." },
  { ...DEMO_SUMMARY, id: 2, generated_at: daysAgo(2), timeline_title: "Sample shared", timeline_body: "A sample forecast was shared for review." },
  { ...DEMO_SUMMARY, id: 3, generated_at: hoursAgo(2), timeline_title: "Assumptions recorded", timeline_body: "The team listed planning assumptions to confirm." },
];

export const DEMO_MEETING_METADATA = [
  {
    id: 1,
    file_display_name: "team-sync.docx",
    file_path: `${DEMO_ROOT}/team-sync.docx`,
    meeting_title: "Delivery Planning Review",
    timeline_title: "Harborline Planning Sync",
    meeting_date: dateDaysAgo(4),
    meeting_time: "10:00 AM",
    attendees: ["Operations Lead", "Data Team", "Planning Team"],
    agenda: "Review the sample forecast and identify assumptions that need confirmation.",
    achieved: "The team agreed to record open assumptions before comparing options.",
  },
];

export const DEMO_TASKS = [
  { id: 1, topic: DEMO_TOPIC_ID, topic_name: DEMO_TOPIC.name, title: "Review the sample delivery forecast", assignee: "Operations Lead", status: "in_progress", due_date: dateDaysAgo(-3), created_at: daysAgo(4), updated_at: daysAgo(1) },
  { id: 2, topic: DEMO_TOPIC_ID, topic_name: DEMO_TOPIC.name, title: "Record forecast assumptions", assignee: "Data Team", status: "backlog", due_date: dateDaysAgo(-5), created_at: daysAgo(3), updated_at: daysAgo(3) },
  { id: 3, topic: DEMO_TOPIC_ID, topic_name: DEMO_TOPIC.name, title: "Compare two delivery planning options", assignee: "Planning Team", status: "backlog", due_date: null, created_at: daysAgo(2), updated_at: daysAgo(2) },
  { id: 4, topic: DEMO_TOPIC_ID, topic_name: DEMO_TOPIC.name, title: "Share review notes with the team", assignee: "Data Team", status: "done", due_date: null, created_at: daysAgo(6), updated_at: daysAgo(5) },
];

export const DEMO_WORKFLOW_HISTORY = [];

// Keyword matching keeps example answers useful while making clear that no
// language model or live project source is connected to this static demo.
export const DEMO_QA = [
  {
    keywords: ["status", "current state", "where"],
    question: "What is the current status?",
    answer: DEMO_SUMMARY.current_state,
  },
  {
    keywords: ["next", "step"],
    question: "What is the next step?",
    answer: DEMO_SUMMARY.next_step,
  },
  {
    keywords: ["waiting", "promise"],
    question: "What are we waiting on?",
    answer: DEMO_SUMMARY.promises_made,
  },
  {
    keywords: ["risk", "question", "open"],
    question: "What are the open questions?",
    answer: DEMO_SUMMARY.risks_and_gaps,
  },
  {
    keywords: ["customer", "team", "think"],
    question: "What does the team think?",
    answer: DEMO_SUMMARY.customer_thoughts,
  },
];

export function answerDummyQuestion(question) {
  const query = (question || "").toLowerCase();
  const match = DEMO_QA.find((item) => item.keywords.some((keyword) => query.includes(keyword)));
  if (match) return match.answer;
  return (
    "This static demo only knows a few example questions. Try asking about the " +
    "current status, next step, open questions, or what the sample team thinks."
  );
}
