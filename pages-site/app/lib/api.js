// Client-side API adapter for the static site. It keeps the supplied demo
// pages working, while locally created empty projects stay in this browser.

import {
  DEMO_TOPIC,
  DEMO_TOPIC_ID,
  DEMO_SUMMARY,
  DEMO_SUMMARY_HISTORY,
  DEMO_MEETING_METADATA,
  DEMO_TASKS,
  DEMO_WORKFLOW_HISTORY,
  answerDummyQuestion,
} from "./dummyData";

export const API_BASE = "";

const STORAGE_KEY = "orientme-demo-projects-v1";
const settle = (value, ms = 150) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const clone = (value) => JSON.parse(JSON.stringify(value));

let tasks = DEMO_TASKS.map((task) => ({ ...task }));
let messages = DEMO_TOPIC.messages.map((message) => ({ ...message }));
let summary = { ...DEMO_SUMMARY };

function readCustomTopics() {
  if (typeof window === "undefined") return [];
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed)
      ? parsed.filter((topic) => topic && typeof topic.id === "string" && typeof topic.name === "string")
      : [];
  } catch {
    // A damaged or blocked local-storage entry must not hide the fixed demo.
    return [];
  }
}

function writeCustomTopics(topics) {
  try {
    if (typeof window === "undefined") throw new Error("Browser storage is not available.");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(topics));
  } catch {
    throw new Error("This browser could not save the project. Allow site storage and try again.");
  }
}

function currentDemoTopic() {
  return { ...DEMO_TOPIC, messages: clone(messages), folders: clone(DEMO_TOPIC.folders), files: clone(DEMO_TOPIC.files) };
}

function allTopics() {
  return [currentDemoTopic(), ...readCustomTopics()];
}

function findCustomTopic(topicId) {
  return readCustomTopics().find((topic) => topic.id === String(topicId));
}

function makeProjectId() {
  return globalThis.crypto?.randomUUID?.() || `project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const api = {
  listTopics: () => settle(allTopics()),

  orient: (text, topicId) => {
    const selected = topicId ? allTopics().find((topic) => topic.id === String(topicId)) : currentDemoTopic();
    if (!selected) return settle({ outcome: "no_match", candidates: [] }, 300);
    const isEmptyProject = selected.id !== DEMO_TOPIC_ID;
    return settle(
      {
        outcome: "matched",
        topic: selected,
        answer: {
          content: isEmptyProject
            ? "This project has no source material yet. GitHub Pages cannot scan folders or generate AI answers."
            : answerDummyQuestion(text),
          is_llm: false,
          generation_note: "This static demo uses fictional sample content and has no live AI or backend.",
          source_files: [],
        },
      },
      300
    );
  },

  getTopic: (topicId = DEMO_TOPIC_ID) => {
    if (String(topicId) === DEMO_TOPIC_ID) return settle(currentDemoTopic());
    const topic = findCustomTopic(topicId);
    return topic ? settle(topic) : Promise.reject(new Error("This project was not found in this browser."));
  },

  createTopic: async (data = {}) => {
    const name = String(data.name || "").trim();
    if (!name) throw new Error("Enter a project name to continue.");

    const topics = readCustomTopics();
    const createdAt = new Date().toISOString();
    const topic = {
      id: makeProjectId(),
      name,
      topic_type: data.topic_type || "project",
      one_liner: String(data.one_liner || "").trim(),
      related_people: String(data.related_people || "").trim(),
      created_at: createdAt,
      last_activity_at: createdAt,
      folders: [],
      files: [],
      file_count: 0,
      latest_risks_and_gaps: "",
      messages: [],
    };
    writeCustomTopics([...topics, topic]);
    return settle(topic);
  },

  autoCreateTopic: () => Promise.reject(new Error("Folder scanning needs the full OrientMe backend; it is unavailable on this static demo.")),
  addFolder: () => Promise.reject(new Error("Folder scanning needs the full OrientMe backend; it is unavailable on this static demo.")),
  ingest: () => Promise.reject(new Error("File scanning needs the full OrientMe backend; it is unavailable on this static demo.")),
  getScanStatus: () => Promise.reject(new Error("File scanning needs the full OrientMe backend; it is unavailable on this static demo.")),
  importTasksCsv: () => Promise.reject(new Error("CSV import needs the full OrientMe backend; it is unavailable on this static demo.")),
  importSummaryCsv: () => Promise.reject(new Error("CSV import needs the full OrientMe backend; it is unavailable on this static demo.")),
  uploadFile: () => Promise.reject(new Error("File uploads need the full OrientMe backend; they are unavailable on this static demo.")),
  importMbox: () => Promise.reject(new Error("Email import needs the full OrientMe backend; it is unavailable on this static demo.")),
  importIcs: () => Promise.reject(new Error("Calendar import needs the full OrientMe backend; it is unavailable on this static demo.")),
  uploadFolder: () => Promise.reject(new Error("Folder uploads need the full OrientMe backend; they are unavailable on this static demo.")),
  pasteText: () => Promise.reject(new Error("Adding source text needs the full OrientMe backend; it is unavailable on this static demo.")),

  ask: (topicId, question) => {
    if (String(topicId) !== DEMO_TOPIC_ID) {
      return settle({
        id: `local-${Date.now()}`,
        role: "assistant",
        content: "This project has no source material yet. GitHub Pages cannot scan files or generate AI answers.",
        created_at: new Date().toISOString(),
        is_llm: false,
        source_files: [],
        generation_note: "Static demo: no live AI or backend is connected.",
      }, 300);
    }

    const answer = answerDummyQuestion(question);
    const userMessage = { id: messages.length + 1, role: "user", content: question, created_at: new Date().toISOString() };
    const assistantMessage = {
      id: messages.length + 2,
      role: "assistant",
      content: answer,
      created_at: new Date().toISOString(),
      is_llm: false,
      source_files: [],
      generation_note: "Answered from fictional examples in this static demo; no live AI is connected.",
    };
    messages = [...messages, userMessage, assistantMessage];
    return settle(assistantMessage, 300);
  },
  clearTopicChat: (topicId = DEMO_TOPIC_ID) => {
    if (String(topicId) === DEMO_TOPIC_ID) messages = [];
    return settle(null);
  },

  getMeetingMetadata: (topicId = DEMO_TOPIC_ID) => settle(String(topicId) === DEMO_TOPIC_ID ? DEMO_MEETING_METADATA : []),
  computePayroll: () => Promise.reject(new Error("Payroll is not part of this demo.")),
  approvePayroll: () => Promise.reject(new Error("Payroll is not part of this demo.")),
  getCalendar: () => settle([]),
  getTasks: (topicId) => settle(topicId && String(topicId) !== DEMO_TOPIC_ID ? [] : tasks),
  getStats: () => settle({ topics: allTopics().length, files: DEMO_TOPIC.files.length, tasks: tasks.length }),
  getGlobalChat: () => settle([]),
  askGlobal: (question) => settle({ id: 1, role: "assistant", content: answerDummyQuestion(question), is_llm: false, source_files: [] }),
  clearGlobalChat: () => settle(null),
  updateTaskStatus: (taskId, status) => {
    tasks = tasks.map((task) => (task.id === taskId ? { ...task, status, updated_at: new Date().toISOString() } : task));
    return settle(tasks.find((task) => task.id === taskId));
  },
  updateTaskDueDate: (taskId, dueDate) => {
    tasks = tasks.map((task) => (task.id === taskId ? { ...task, due_date: dueDate || null } : task));
    return settle(tasks.find((task) => task.id === taskId));
  },
  deleteTopic: () => Promise.reject(new Error("Deleting projects is unavailable in this static demo.")),
  getSettings: () => settle({ stale_after_days: "14" }),
  saveSettings: () => settle({ saved: true }),

  getLatestSummary: (topicId = DEMO_TOPIC_ID) => settle(String(topicId) === DEMO_TOPIC_ID ? summary : null),
  refreshSummary: (topicId = DEMO_TOPIC_ID) => {
    if (String(topicId) !== DEMO_TOPIC_ID) {
      return Promise.reject(new Error("AI-generated briefs need the full OrientMe backend."));
    }
    summary = { ...summary, generated_at: new Date().toISOString() };
    return settle(summary, 400);
  },
  getSummaryHistory: (topicId = DEMO_TOPIC_ID) => settle(String(topicId) === DEMO_TOPIC_ID ? DEMO_SUMMARY_HISTORY : []),
  getWorkflowHistory: (topicId = DEMO_TOPIC_ID) => settle(String(topicId) === DEMO_TOPIC_ID ? DEMO_WORKFLOW_HISTORY : []),
  aiExecuteTask: () => Promise.reject(new Error("AI task execution is unavailable in this static demo.")),
  listLoops: () => settle([]),
  createLoop: () => Promise.reject(new Error("Loops are unavailable in this static demo.")),
  runLoop: () => Promise.reject(new Error("Loops are unavailable in this static demo.")),
  deleteLoop: () => Promise.reject(new Error("Loops are unavailable in this static demo.")),
  getConnectorStatuses: () => settle([]),
  requestConnector: () => Promise.reject(new Error("Connectors are unavailable in this static demo.")),
  resetConnector: () => Promise.reject(new Error("Connectors are unavailable in this static demo.")),

  search: (queryText) => {
    const query = (queryText || "").toLowerCase();
    const projects = allTopics()
      .filter((topic) => !query || `${topic.name} ${topic.one_liner || ""}`.toLowerCase().includes(query))
      .map((topic) => ({ id: topic.id, name: topic.name, one_liner: topic.one_liner }));
    return settle({ projects, stakeholders: [], tasks: [], files: [] });
  },

  primeCsrf: () => settle({ ok: true }),
  login: () => settle({ username: "demo", display_name: "Demo User", role: "admin" }),
  logout: () => settle({ ok: true }),
  me: () => settle({ authenticated: true, username: "demo", display_name: "Demo User", role: "admin" }),
  changePassword: () => Promise.reject(new Error("Password changes are unavailable in this static demo.")),
  updateProfile: () => settle({ ok: true }),
};
