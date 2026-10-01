// Standalone demo build: no Django backend exists in this repo (only the
// frontend was published - see README). Every function below has the exact
// same name/signature as the real app's api.js, but instead of a fetch()
// call it reads/writes the in-memory fixture store (./fixtures.js). This
// keeps every page's own code completely unchanged - only this one file
// (plus AuthContext.js's login gate) had to change for the conversion.
//
// Nothing here is presented as a real network/AI call: every AI-shaped
// response (ask/orient/refreshSummary/aiExecuteTask) sets is_llm=false with
// a generation_note saying so, using the exact same "not a live answer"
// banner the real app already renders for its own no-API-key fallback -
// no new UI needed for that honesty requirement.
//
// State is in-memory only and resets on every page reload - intentional
// for a public demo (see fixtures.js), not a bug.

import { store, newId } from "./fixtures";
import { generateDemoAnswer } from "./localModel";

// Deterministic, code-based meeting summary - ported from the real app's
// core/extraction.py::build_meeting_summary. No model call at all (not
// even the in-browser one Ask/Orient uses) - a per-recording summary is
// well within reach of plain extractive scoring, so it doesn't need one.
// Frequency-based extractive scoring (the same family as TextRank/Luhn's
// algorithm): count which non-stopword, non-filler words repeat most
// across the whole transcript, score each line by how many DISTINCT such
// words it contains (normalized by its own distinct-word count so a line
// repeating one word several times doesn't inflate its own score), then
// keep the highest-scoring lines in their original order.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "are", "was", "were", "will", "what", "who",
  "when", "where", "why", "how", "all", "any", "can", "did", "does", "not",
  "should", "would", "could", "this", "that", "from", "have", "has", "had",
  "you", "your", "our", "their", "its", "his", "her", "them", "they", "about",
  "into", "over", "under", "than", "then", "there", "here", "some", "more",
  "most", "such", "each", "both", "just", "also", "get", "got", "give",
]);
const SPOKEN_FILLER_WORDS = new Set([
  "yeah", "sure", "okay", "right", "like", "just", "well", "really",
  "actually", "basically", "kind", "sort", "gonna", "wanna", "hmm", "umm",
  "hello", "thanks", "thank",
]);

function lineWords(line) {
  const words = (line.match(/[a-zA-Z']+/g) || []).map((w) => w.toLowerCase());
  return new Set(words.filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !SPOKEN_FILLER_WORDS.has(w)));
}

function buildMeetingSummary(text) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return "No summarizable content found - this transcript is empty.";
  }

  const lineSets = lines.map(lineWords);
  const wordCounts = {};
  for (const words of lineSets) {
    for (const w of words) wordCounts[w] = (wordCounts[w] || 0) + 1;
  }
  const scores = lineSets.map((words) => {
    if (words.size === 0) return 0;
    let sum = 0;
    for (const w of words) sum += wordCounts[w];
    return sum / words.size;
  });

  const topN = Math.min(4, lines.length);
  const topIndices = scores
    .map((score, i) => [score, i])
    .sort((a, b) => b[0] - a[0])
    .slice(0, topN)
    .map(([, i]) => i)
    .filter((i) => scores[i] > 0)
    .sort((a, b) => a - b);

  if (topIndices.length === 0) {
    return "No summarizable content found - no lines with distinctive enough wording to extract highlights from.";
  }
  return "**Highlights:**\n" + topIndices.map((i) => `- ${lines[i]}`).join("\n");
}

// GitHub Pages is static, so this adapter keeps the ZIP's fixture behavior in
// the browser and runs only Ask/Orient through the local browser model.
export const API_BASE = "";
const LOCAL_PROJECTS_KEY = "orientme-demo-local-projects-v1";
export function getCsrfToken() {
  return "";
}

function wait(ms = 220) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function topicBrief(t) {
  return { id: t.id, name: t.name, one_liner: t.one_liner, topic_type: t.topic_type };
}

function fileWithMeta(f) {
  return {
    id: f.id,
    path: f.path,
    display_name: f.display_name,
    source_method: f.source_method,
    artifact_type: f.meta ? "meeting" : "file",
    content_hash: f.content_hash,
    extraction_error: f.extraction_error,
    first_added_at: f.first_added_at,
    last_ingested_at: f.last_ingested_at,
    meta: f.meta,
  };
}

function topicFiles(topicId) {
  return store.files.filter((f) => f.topic === topicId);
}

function topicSummaries(topicId) {
  return store.summaries
    .filter((s) => s.topic === topicId)
    .slice()
    .sort((a, b) => new Date(b.generated_at) - new Date(a.generated_at));
}

function latestSummary(topicId) {
  return topicSummaries(topicId)[0] || null;
}

function lastActivityAt(topic) {
  const candidates = [topic.created_at];
  const latest = latestSummary(topic.id);
  if (latest) candidates.push(latest.generated_at);
  const files = topicFiles(topic.id);
  if (files.length) {
    candidates.push(files.slice().sort((a, b) => new Date(b.first_added_at) - new Date(a.first_added_at))[0].first_added_at);
  }
  return candidates.reduce((a, b) => (new Date(a) > new Date(b) ? a : b));
}

function topicListItem(topic) {
  const latest = latestSummary(topic.id);
  return {
    id: topic.id,
    name: topic.name,
    topic_type: topic.topic_type,
    one_liner: topic.one_liner,
    related_people: topic.related_people,
    created_at: topic.created_at,
    folders: store.folders.filter((f) => f.topic === topic.id),
    file_count: topicFiles(topic.id).length,
    last_activity_at: lastActivityAt(topic),
    latest_risks_and_gaps: (latest?.risks_and_gaps || "").trim(),
  };
}

function topicDetail(topic) {
  return {
    ...topicListItem(topic),
    files: topicFiles(topic.id).map(fileWithMeta),
    messages: store.messages.filter((m) => m.topic === topic.id),
  };
}

function findTopic(id) {
  const numId = Number(id);
  return store.topics.find((t) => String(t.id) === String(id) || t.id === numId) || null;
}

function newLocalProjectId() {
  // Keep custom project IDs numeric for the existing UI, while avoiding the
  // fixture store's low sequential IDs after a browser reload.
  return Date.now() * 100 + Math.floor(Math.random() * 100);
}

function readLocalProjects() {
  if (typeof window === "undefined") return [];
  try {
    const saved = JSON.parse(window.localStorage.getItem(LOCAL_PROJECTS_KEY) || "[]");
    return Array.isArray(saved)
      ? saved.filter((topic) => topic && Number.isFinite(Number(topic.id)) && typeof topic.name === "string")
      : [];
  } catch {
    return [];
  }
}

function saveLocalProjects() {
  if (typeof window === "undefined") return;
  const demoIds = new Set([1, 2, 3]);
  const localProjects = store.topics.filter((topic) => !demoIds.has(Number(topic.id)));
  try {
    window.localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(localProjects));
  } catch {
    throw new Error("This browser could not save the project. Allow site storage and try again.");
  }
}

function modelContext(topic) {
  const summary = latestSummary(topic.id) || {};
  const tasks = store.tasks.filter((task) => task.topic === topic.id).slice(0, 12);
  const commitments = store.commitments.filter((item) => item.topic === topic.id).slice(0, 8);
  const decisions = store.decisions.filter((item) => item.topic === topic.id).slice(0, 8);
  const risks = store.risks.filter((item) => item.topic === topic.id).slice(0, 8);
  return [
    `Project: ${topic.name}. ${topic.one_liner || ""}`,
    summary.current_state && `Current state: ${summary.current_state}`,
    summary.next_step && `Next steps: ${summary.next_step}`,
    summary.risks_and_gaps && `Risks and gaps: ${summary.risks_and_gaps}`,
    tasks.length && `Tasks: ${tasks.map((task) => `${task.title} (${task.status}, ${task.assignee || "unassigned"})`).join("; ")}`,
    commitments.length && `Commitments: ${commitments.map((item) => `${item.person}: ${item.commitment} (${item.status})`).join("; ")}`,
    decisions.length && `Decisions: ${decisions.map((item) => item.decision).join("; ")}`,
    risks.length && `Open risks: ${risks.map((item) => item.description).join("; ")}`,
  ].filter(Boolean).join("\n");
}

async function liveAnswer(topic, question) {
  if (topicFiles(topic.id).length === 0) {
    return {
      content: "This project has no source material yet. Add sample source content in the full OrientMe app before asking for an evidence-based answer.",
      is_llm: false,
      generation_note: "No source material is attached to this browser-created project, so the local model was not called.",
      source_files: [],
    };
  }
  const content = await generateDemoAnswer(question, undefined, modelContext(topic));
  return {
    content,
    is_llm: true,
    generation_note: "Generated on this device by a small browser model using fictional demo data. Review the sample records before relying on an answer.",
    source_files: [],
  };
}

// A small, deliberately simple stand-in for the real app's word-scored
// resolve_topic - good enough to demo "type a project name, get routed to
// it," not a claim of matching the real algorithm's sophistication.
function resolveDemoTopic(requestText) {
  const lowered = requestText.toLowerCase();
  const scored = store.topics.map((t) => {
    const nameWords = t.name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    const score = nameWords.filter((w) => lowered.includes(w)).length;
    return { topic: t, score };
  });
  const max = Math.max(0, ...scored.map((s) => s.score));
  if (max === 0) {
    return { outcome: "no_match", suggested_name: store.topics[0]?.name || "" };
  }
  const tied = scored.filter((s) => s.score === max).map((s) => s.topic);
  if (tied.length === 1) return { outcome: "matched", topic: tied[0] };
  return { outcome: "ambiguous", topics: tied.slice(0, 5) };
}

// Shared by ask()/orient()/refreshSummary() - always a clearly-labeled
// simulated answer (see this file's header comment), built from whatever
// this topic's own latest fixture summary already says, lightly reworded
// per the question's own keywords so different Smart Suggestions read as
// genuinely different answers rather than one canned block repeated.
function simulateAsk(topic, question) {
  const latest = latestSummary(topic.id);
  const lowered = (question || "").toLowerCase();
  let content;
  if (!latest) {
    content = `No brief has been generated for ${topic.name} yet in this demo.`;
  } else if (lowered.includes("changed") || lowered.includes("update")) {
    content = latest.latest_updates?.trim() || latest.answer_summary;
  } else if (lowered.includes("meeting") || lowered.includes("prepare")) {
    content =
      latest.meeting_prep?.trim() ||
      `${topic.name}: no meeting-specific prep notes in this demo — here's the current state instead.\n\n${latest.current_state}`;
  } else if (lowered.includes("attention") || lowered.includes("risk")) {
    content = latest.risks_and_gaps?.trim() || `No open risks recorded for ${topic.name} in this demo.`;
  } else {
    content = latest.answer_summary;
  }

  const sourceFiles = (latest?.sources_used || [])
    .map((path) => {
      const f = topicFiles(topic.id).find((x) => x.path === path);
      return f ? { id: f.id, path: f.path, display_name: f.display_name, first_added_at: f.first_added_at } : null;
    })
    .filter(Boolean);

  return {
    content,
    is_llm: false,
    generation_note: "Demo mode — this is a simulated answer built from sample data, not a live model call.",
    source_files: sourceFiles,
  };
}

function recordMessages(topicId, question, answer) {
  store.messages.push({
    id: newId(),
    topic: topicId,
    role: "user",
    content: question,
    source_files: [],
    is_llm: false,
    generation_note: "",
    created_at: new Date().toISOString(),
  });
  store.messages.push({
    id: newId(),
    topic: topicId,
    role: "assistant",
    content: answer.content,
    source_files: answer.source_files,
    is_llm: answer.is_llm,
    generation_note: answer.generation_note,
    created_at: new Date().toISOString(),
  });
}

export const api = {
  listTopics: async () => {
    await wait();
    return store.topics.map(topicListItem);
  },
  loadLocalProjects: async () => {
    const saved = readLocalProjects();
    const present = new Set(store.topics.map((topic) => String(topic.id)));
    store.topics.push(...saved.filter((topic) => !present.has(String(topic.id))));
  },
  orient: async (requestText, topicId) => {
    await wait();
    if (topicId) {
      const topic = findTopic(topicId);
      if (!topic) return { outcome: "no_match", suggested_name: "" };
      const answer = await liveAnswer(topic, requestText);
      recordMessages(topic.id, requestText, answer);
      return { outcome: "matched", topic: topicBrief(topic), answer };
    }
    const result = resolveDemoTopic(requestText);
    if (result.outcome === "matched") {
      const answer = await liveAnswer(result.topic, requestText);
      recordMessages(result.topic.id, requestText, answer);
      return { outcome: "matched", topic: topicBrief(result.topic), answer };
    }
    if (result.outcome === "ambiguous") {
      return { outcome: "ambiguous", candidates: result.topics.map(topicBrief) };
    }
    return { outcome: "no_match", suggested_name: result.suggested_name };
  },
  getTopic: async (id) => {
    await wait();
    const topic = findTopic(id);
    if (!topic) throw new Error("404 Not Found: no such project in this demo");
    return topicDetail(topic);
  },
  createTopic: async (data) => {
    await wait();
    const topic = {
      id: newLocalProjectId(),
      name: data.name || "Untitled project",
      topic_type: data.topic_type || "project",
      one_liner: data.one_liner || "",
      related_people: data.related_people || "",
      created_at: new Date().toISOString(),
    };
    store.topics.unshift(topic);
    saveLocalProjects();
    return topicDetail(topic);
  },
  autoCreateTopic: async (folderPaths, name) => {
    await wait(500);
    const topicName = name || (folderPaths[0] || "New project").split(/[\\/]/).pop();
    const topic = {
      id: newId(),
      name: topicName,
      topic_type: "project",
      one_liner: "Demo project — sample content only (this build has no real folder-scanning backend).",
      related_people: "",
      created_at: new Date().toISOString(),
    };
    store.topics.unshift(topic);
    (folderPaths || []).forEach((p) => store.folders.push({ id: newId(), topic: topic.id, path: p, added_at: new Date().toISOString() }));
    store.files.push({
      id: newId(),
      topic: topic.id,
      path: "Sample Document.txt",
      display_name: "Sample Document.txt",
      source_method: "folder",
      content_hash: "demo",
      extraction_error: "",
      first_added_at: new Date().toISOString(),
      last_ingested_at: new Date().toISOString(),
      meta: null,
    });
    return topicDetail(topic);
  },
  addFolder: async (topicId, path) => {
    await wait();
    store.folders.push({ id: newId(), topic: Number(topicId), path, added_at: new Date().toISOString() });
    return { ok: true };
  },
  ingest: async () => {
    await wait(400);
    return { status: "done", scanned: 0, added: 0, updated: 0, unchanged: 0 };
  },
  getScanStatus: async () => ({ status: "done", total_files: 0, processed_files: 0 }),
  importTasksCsv: async () => {
    await wait(400);
    return { updated: 0, skipped: 0 };
  },
  importSummaryCsv: async () => {
    await wait(400);
    return { updated: 0, skipped: 0 };
  },
  uploadFile: async (topicId, file) => {
    await wait(400);
    store.files.push({
      id: newId(),
      topic: Number(topicId),
      path: file.name,
      display_name: file.name,
      source_method: "upload",
      content_hash: "demo",
      extraction_error: "",
      first_added_at: new Date().toISOString(),
      last_ingested_at: new Date().toISOString(),
      meta: null,
    });
    return { ok: true };
  },
  importMbox: async () => {
    await wait(400);
    return { added: 0 };
  },
  importIcs: async () => {
    await wait(400);
    return { added: 0 };
  },
  pasteText: async (topicId, text, label) => {
    await wait();
    store.files.push({
      id: newId(),
      topic: Number(topicId),
      path: `pasted:${label || "note"}`,
      display_name: label || "Pasted text",
      source_method: "paste",
      content_hash: "demo",
      extraction_error: "",
      first_added_at: new Date().toISOString(),
      last_ingested_at: new Date().toISOString(),
      meta: null,
    });
    return { ok: true };
  },
  ask: async (topicId, question) => {
    await wait();
    const topic = findTopic(topicId);
    if (!topic) throw new Error("This project is not available in this browser.");
    const answer = await liveAnswer(topic, question);
    recordMessages(topic.id, question, answer);
    return { ...answer, role: "assistant" };
  },
  clearTopicChat: async (topicId) => {
    await wait();
    store.messages = store.messages.filter((m) => m.topic !== Number(topicId));
    return { ok: true };
  },
  uploadFolder: async (topicId) => {
    await wait(500);
    return { added: 0, updated: 0, unchanged: 0 };
  },
  getMeetingMetadata: async (topicId) => {
    await wait();
    return topicFiles(Number(topicId))
      .filter((f) => f.meta)
      .map((f) => ({
        id: f.meta.id,
        file_display_name: f.display_name,
        file_path: f.path,
        meeting_title: f.meta.meeting_title,
        timeline_title: f.meta.meeting_title,
        meeting_date: f.meta.meeting_date,
        meeting_time: f.meta.meeting_time,
        attendees: f.meta.attendees,
        agenda: f.meta.agenda,
        achieved: f.meta.achieved,
      }))
      .sort((a, b) => (b.meeting_date || "").localeCompare(a.meeting_date || ""));
  },
  computePayroll: async (topicId) => {
    await wait(500);
    const workflow = {
      id: newId(),
      topic: Number(topicId),
      workflow_type: "payroll_approval",
      status: "pending",
      computed_data: { month: new Date().toISOString().slice(0, 7), employees: [] },
      created_at: new Date().toISOString(),
      approved_at: null,
    };
    store.workflows.unshift(workflow);
    return { id: workflow.id, computed_data: workflow.computed_data, created_at: workflow.created_at };
  },
  approvePayroll: async (topicId, workflowId) => {
    await wait();
    const wf = store.workflows.find((w) => w.id === Number(workflowId));
    if (wf) {
      wf.status = "approved";
      wf.approved_at = new Date().toISOString();
    }
    return wf;
  },
  getCalendar: async (topicId) => {
    await wait();
    const events = [];
    store.files.forEach((f) => {
      if (!f.meta || !f.meta.meeting_date) return;
      if (topicId && f.topic !== Number(topicId)) return;
      const topic = findTopic(f.topic);
      events.push({
        kind: "meeting",
        date: f.meta.meeting_date,
        topic_id: topic.id,
        topic_name: topic.name,
        topic_type: topic.topic_type,
        id: f.meta.id,
        file_display_name: f.display_name,
        file_path: f.path,
        meeting_title: f.meta.meeting_title,
        meeting_date: f.meta.meeting_date,
        meeting_time: f.meta.meeting_time,
        attendees: f.meta.attendees,
        agenda: f.meta.agenda,
        achieved: f.meta.achieved,
      });
    });
    store.tasks.forEach((t) => {
      if (!t.due_date) return;
      if (topicId && t.topic !== Number(topicId)) return;
      const topic = findTopic(t.topic);
      events.push({
        kind: "task",
        date: t.due_date,
        topic_id: topic.id,
        topic_name: topic.name,
        topic_type: topic.topic_type,
        id: t.id,
        title: t.title,
        assignee: t.assignee,
        status: t.status,
        due_date: t.due_date,
      });
    });
    return events.sort((a, b) => b.date.localeCompare(a.date));
  },
  getTasks: async (topicId) => {
    await wait();
    return store.tasks
      .filter((t) => !topicId || t.topic === Number(topicId))
      .map((t) => ({ ...t, topic_name: findTopic(t.topic)?.name || "" }));
  },
  createTask: async (topicId, { title, assignee, due_date }) => {
    await wait();
    const task = {
      id: newId(),
      topic: Number(topicId),
      source_file: null,
      title,
      assignee: assignee || "",
      due_date: due_date || null,
      status: "backlog",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.tasks.push(task);
    return { ...task, topic_name: findTopic(task.topic)?.name || "" };
  },
  updateTask: async (taskId, fields) => {
    await wait();
    const task = store.tasks.find((t) => t.id === Number(taskId));
    if (!task) throw new Error("404 Not Found");
    Object.assign(task, fields, { updated_at: new Date().toISOString() });
    return { ...task, topic_name: findTopic(task.topic)?.name || "" };
  },
  deleteTask: async (taskId) => {
    await wait();
    store.tasks = store.tasks.filter((t) => t.id !== Number(taskId));
    return null;
  },
  getCommitments: async (topicId) => {
    await wait();
    return store.commitments
      .filter((c) => !topicId || c.topic === Number(topicId))
      .map((c) => ({
        ...c,
        linked_task_title: c.linked_task ? store.tasks.find((t) => t.id === c.linked_task)?.title || "" : "",
      }));
  },
  createCommitment: async (topicId, { person, commitment, date_made, due_date, linked_task }) => {
    await wait();
    const row = {
      id: newId(),
      topic: Number(topicId),
      source_file: null,
      linked_task: linked_task ? Number(linked_task) : null,
      person,
      commitment,
      date_made: date_made || null,
      due_date: due_date || null,
      status: "open",
      created_at: new Date().toISOString(),
    };
    store.commitments.push(row);
    return { ...row, linked_task_title: row.linked_task ? store.tasks.find((t) => t.id === row.linked_task)?.title || "" : "" };
  },
  updateCommitment: async (commitmentId, fields) => {
    await wait();
    const row = store.commitments.find((c) => c.id === Number(commitmentId));
    if (!row) throw new Error("404 Not Found");
    Object.assign(row, fields);
    return { ...row, linked_task_title: row.linked_task ? store.tasks.find((t) => t.id === row.linked_task)?.title || "" : "" };
  },
  deleteCommitment: async (commitmentId) => {
    await wait();
    store.commitments = store.commitments.filter((c) => c.id !== Number(commitmentId));
    return null;
  },
  getRisks: async (topicId) => {
    await wait();
    return store.risks.filter((r) => !topicId || r.topic === Number(topicId));
  },
  createRisk: async (topicId, { description, impact, owner }) => {
    await wait();
    const row = {
      id: newId(),
      topic: Number(topicId),
      source_file: null,
      description,
      impact: impact || "",
      owner: owner || "",
      status: "open",
      created_at: new Date().toISOString(),
    };
    store.risks.push(row);
    return row;
  },
  updateRisk: async (riskId, fields) => {
    await wait();
    const row = store.risks.find((r) => r.id === Number(riskId));
    if (!row) throw new Error("404 Not Found");
    Object.assign(row, fields);
    return row;
  },
  deleteRisk: async (riskId) => {
    await wait();
    store.risks = store.risks.filter((r) => r.id !== Number(riskId));
    return null;
  },
  getDecisions: async (topicId) => {
    await wait();
    return store.decisions.filter((d) => !topicId || d.topic === Number(topicId));
  },
  createDecision: async (topicId, { decision, context, participants, decided_date }) => {
    await wait();
    const row = {
      id: newId(),
      topic: Number(topicId),
      source_file: null,
      decision,
      context: context || "",
      participants: participants || "",
      decided_date: decided_date || null,
      status: "decided",
      created_at: new Date().toISOString(),
    };
    store.decisions.push(row);
    return row;
  },
  updateDecision: async (decisionId, fields) => {
    await wait();
    const row = store.decisions.find((d) => d.id === Number(decisionId));
    if (!row) throw new Error("404 Not Found");
    Object.assign(row, fields);
    return row;
  },
  deleteDecision: async (decisionId) => {
    await wait();
    store.decisions = store.decisions.filter((d) => d.id !== Number(decisionId));
    return null;
  },
  getProjectState: async (topicId) => {
    await wait();
    let state = store.projectStates.find((s) => s.topic === Number(topicId));
    if (!state) {
      state = { id: newId(), topic: Number(topicId), current_position: "", previous_position: "", updated_at: new Date().toISOString(), updated_by: "" };
      store.projectStates.push(state);
    }
    return state;
  },
  updateProjectState: async (topicId, currentPosition) => {
    await wait();
    let state = store.projectStates.find((s) => s.topic === Number(topicId));
    if (!state) {
      state = { id: newId(), topic: Number(topicId), current_position: "", previous_position: "", updated_at: "", updated_by: "" };
      store.projectStates.push(state);
    }
    state.previous_position = state.current_position;
    state.current_position = currentPosition;
    state.updated_at = new Date().toISOString();
    state.updated_by = store.user.display_name;
    return state;
  },
  getStats: async () => {
    await wait();
    return {
      topics: store.topics.length,
      files: store.files.length,
      meetings: store.files.filter((f) => f.meta).length,
      tasks_backlog: store.tasks.filter((t) => t.status === "backlog").length,
      tasks_in_progress: store.tasks.filter((t) => t.status === "in_progress").length,
      tasks_done: store.tasks.filter((t) => t.status === "done").length,
    };
  },
  getGlobalChat: async () => [],
  askGlobal: async (question) => {
    await wait();
    const result = resolveDemoTopic(question);
    if (result.outcome === "matched") return liveAnswer(result.topic, question);
    return { content: "No project matches that question in this demo.", is_llm: false, generation_note: "No model was called because no sample project matched.", source_files: [] };
  },
  clearGlobalChat: async () => null,
  updateTaskStatus: (taskId, status) => api.updateTask(taskId, { status }),
  updateTaskDueDate: (taskId, dueDate) => api.updateTask(taskId, { due_date: dueDate || null }),
  deleteTopic: async (topicId) => {
    await wait();
    store.topics = store.topics.filter((t) => t.id !== Number(topicId));
    saveLocalProjects();
    return null;
  },
  getSettings: async () => {
    await wait();
    const { llm_api_key, ...rest } = store.settings;
    return rest;
  },
  saveSettings: async (data) => {
    await wait();
    const keySet = data.llm_api_key ? true : store.settings.llm_api_key_set;
    store.settings = { ...store.settings, ...data, llm_api_key_set: keySet };
    delete store.settings.llm_api_key;
    return { ok: true };
  },
  getLatestSummary: async (topicId) => {
    await wait();
    return latestSummary(Number(topicId)) || {};
  },
  refreshSummary: async (topicId, question) => {
    await wait(500);
    const topic = findTopic(topicId);
    const q = question || "Give me the current state and the single best next step for this topic.";
    const answer = await liveAnswer(topic, q);
    recordMessages(topic.id, q, answer);
    const prior = latestSummary(topic.id);
    const fresh = {
      ...(prior || {}),
      id: newId(),
      topic: topic.id,
      answer_summary: answer.content,
      generated_at: new Date().toISOString(),
      is_manual_edit: false,
    };
    store.summaries.unshift(fresh);
    return fresh;
  },
  getSummaryHistory: async (topicId) => {
    await wait();
    return topicSummaries(Number(topicId));
  },
  getWorkflowHistory: async (topicId) => {
    await wait();
    return store.workflows
      .filter((w) => w.topic === Number(topicId))
      .slice()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  },
  aiExecuteTask: async (taskId) => {
    await wait(500);
    const task = store.tasks.find((t) => t.id === Number(taskId));
    return {
      draft: `Hi — quick update on "${task?.title || "this task"}": this is in progress, will follow up with details shortly.`,
      is_llm: false,
      note: "Demo mode — this draft is simulated, not a live model call.",
    };
  },
  listLoops: async () => store.loops,
  createLoop: async (question) => {
    await wait();
    const loop = { id: newId(), question, created_at: new Date().toISOString(), last_run_at: null, run_count: 0 };
    store.loops.push(loop);
    return loop;
  },
  runLoop: async (loopId) => {
    await wait();
    const loop = store.loops.find((l) => l.id === Number(loopId));
    if (loop) {
      loop.last_run_at = new Date().toISOString();
      loop.run_count += 1;
    }
    return loop;
  },
  deleteLoop: async (loopId) => {
    await wait();
    store.loops = store.loops.filter((l) => l.id !== Number(loopId));
    return null;
  },
  getConnectorStatuses: async () => store.connectors,
  requestConnector: async (slug) => {
    await wait();
    const c = store.connectors.find((x) => x.slug === slug);
    if (c) {
      c.status = "requested";
      c.requested_at = new Date().toISOString();
    }
    return c;
  },
  resetConnector: async (slug) => {
    await wait();
    const c = store.connectors.find((x) => x.slug === slug);
    if (c) {
      c.status = "not_connected";
      c.requested_at = null;
    }
    return c;
  },
  // Transcripts page - sample recordings covering all four real outcomes
  // (routed, awaiting a new-project decision, needs review, pre-existing).
  // No live watcher/transcription engine/LLM router behind this build.
  getRecordingEvents: async () => {
    await wait(150);
    return store.recordingEvents.slice().sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at));
  },
  assignRecordingEvent: async (eventId, topicId) => {
    await wait();
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    if (ev) {
      const t = findTopic(Number(topicId));
      ev.topic = t ? t.id : null;
      ev.topic_name = t ? t.name : "";
      ev.status = "routed";
      ev.detail = "Manually assigned.";
    }
    return ev;
  },
  confirmNewProject: async (eventId, overrides = {}) => {
    await wait();
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    if (!ev) return null;
    const topic = {
      id: newId(),
      name: (overrides.name || ev.suggested_topic_name || "Untitled Project").slice(0, 200),
      topic_type: overrides.topic_type || ev.suggested_topic_type || "project",
      one_liner: (overrides.one_liner != null ? overrides.one_liner : ev.suggested_topic_one_liner || "").slice(0, 300),
      related_people: "",
      created_at: new Date().toISOString(),
    };
    store.topics.push(topic);
    ev.topic = topic.id;
    ev.topic_name = topic.name;
    ev.status = "auto_created";
    ev.detail = "New project created from this recording.";
    return ev;
  },
  rejectNewProject: async (eventId) => {
    await wait();
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    if (ev) {
      ev.status = "needs_review";
      ev.detail = "Declined as a new project - assign manually if needed, or leave as a one-off.";
    }
    return ev;
  },
  // Transcript detail page (/transcripts/[id]) - one recording's full text
  // plus the three actions below.
  getRecordingEvent: async (eventId) => {
    await wait(150);
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    if (!ev) throw new Error("404 Not Found: no such recording in this demo");
    return { ...ev };
  },
  getRecordingEventText: async (eventId) => {
    await wait(150);
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    return { text: ev?.transcript_text || "" };
  },
  // Generate Summary - deterministic code, not a model call (previously
  // ran the real in-browser SmolLM2 model; rebuilt per an explicit
  // correction, 29 Sep: "you are using too much llm... focus on codded
  // thing rather than using llm - llm is for tuff works which is
  // imposible to code" - see buildMeetingSummary above, ported from the
  // real app's core/extraction.py::build_meeting_summary). onProgress is
  // accepted (unused) only so the caller doesn't need updating.
  generateRecordingSummary: async (eventId, _onProgress) => {
    await wait();
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    if (!ev) throw new Error("404 Not Found: no such recording in this demo");
    const text = (ev.transcript_text || "").trim();
    if (!text) {
      throw new Error("This recording has no transcript text captured in this demo, so there is nothing to summarize.");
    }
    ev.meeting_summary = buildMeetingSummary(text);
    ev.summary_generated_at = new Date().toISOString();
    return { ...ev };
  },
  // Diarize - the real app asks a local LLM to turn the raw transcript into
  // a structured participants/decisions/action-items/parked-items/per-
  // speaker breakdown (core/recordings.py's diarize_event). This static
  // demo has no LLM behind it at all, so rather than fake a live call, a
  // couple of sample recordings ship with a realistic PRE-BAKED result
  // (fixtures.js's diarization_result, in the exact markdown shape the real
  // app's _render_diarization_markdown produces) - clicking Diarize on one
  // of those just reveals it. Anything without one gets an honest
  // not-available message instead of an error, same as the real app's own
  // "Ollama isn't reachable" graceful-fallback convention.
  diarizeRecording: async (eventId) => {
    await wait(400);
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    if (!ev) throw new Error("404 Not Found: no such recording in this demo");
    if (!ev.diarization_result) {
      return {
        ...ev,
        succeeded: false,
        message:
          "No pre-built Diarize breakdown is available for this recording in this demo — try the Acme Rebrand Weekly Sync or Vendor Security Review Kickoff recordings, which do.",
      };
    }
    ev.diarization_generated_at = new Date().toISOString();
    return { ...ev, succeeded: true, message: "Diarization complete." };
  },
  // Generate Transcript - the real app groups the transcript's own real
  // timestamped lines by speaker (core/recordings.py's
  // generate_speaker_transcript) - every timestamp and word is real, only
  // the speaker label is inferred. This demo mirrors that with pre-baked
  // fixtures.js's speaker_transcript (same [MM:SS] Speaker: text shape),
  // rather than a live call. Same honest not-available fallback as Diarize
  // above when a recording has no pre-baked speaker transcript.
  generateSpeakerTranscript: async (eventId) => {
    await wait(400);
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    if (!ev) throw new Error("404 Not Found: no such recording in this demo");
    if (!ev.speaker_transcript) {
      return {
        ...ev,
        succeeded: false,
        message:
          "No pre-built speaker transcript is available for this recording in this demo — try the Acme Rebrand Weekly Sync or Vendor Security Review Kickoff recordings, which do.",
      };
    }
    ev.speaker_transcript_generated_at = new Date().toISOString();
    return { ...ev, succeeded: true, message: "Transcript generated." };
  },
  // Save - generateRecordingSummary() above already wrote the summary into
  // the fixture store, so this just confirms that (fixture-store-only,
  // resets on refresh - see README). It exists mainly for UI parity with
  // the real app's save button, not because there's real work left to do.
  saveRecordingSummary: async (eventId) => {
    await wait();
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    if (!ev) throw new Error("404 Not Found: no such recording in this demo");
    return { saved: true, summary_generated_at: ev.summary_generated_at };
  },
  search: async (q) => {
    await wait(150);
    const lowered = q.toLowerCase();
    const projects = store.topics.filter((t) => t.name.toLowerCase().includes(lowered)).map(topicBrief);
    const stakeholders = [];
    store.topics.forEach((t) => {
      (t.related_people || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((name) => {
        if (name.toLowerCase().includes(lowered)) stakeholders.push({ name, topic_id: t.id, topic_name: t.name });
      });
    });
    const tasks = store.tasks
      .filter((t) => t.title.toLowerCase().includes(lowered))
      .map((t) => ({ id: t.id, title: t.title, topic_id: t.topic, topic_name: findTopic(t.topic)?.name || "" }));
    const files = store.files
      .filter((f) => f.display_name.toLowerCase().includes(lowered))
      .map((f) => ({ id: f.id, display_name: f.display_name, topic_id: f.topic, topic_name: findTopic(f.topic)?.name || "" }));
    return { projects, stakeholders, tasks, files };
  },
  // Cross-project library/feed - every ingested file, and a merged activity
  // feed (meetings/status updates/tasks), across every project at once.
  // Mirrors the real backend's GlobalSourcesView/GlobalTimelineView logic,
  // just built client-side from the fixture store instead of a DB query.
  getAllSources: async (topicId) => {
    await wait();
    return store.files
      .filter((f) => !topicId || f.topic === Number(topicId))
      .map((f) => {
        const topic = findTopic(f.topic);
        return {
          id: f.id,
          topic_id: topic.id,
          topic_name: topic.name,
          topic_type: topic.topic_type,
          path: f.path,
          display_name: f.display_name,
          source_method: f.source_method,
          artifact_type: f.meta ? "meeting" : "file",
          first_added_at: f.first_added_at,
        };
      })
      .sort((a, b) => new Date(b.first_added_at) - new Date(a.first_added_at));
  },
  getGlobalTimeline: async (topicId) => {
    await wait();
    const events = [];

    store.files.forEach((f) => {
      if (!f.meta || !f.meta.meeting_date) return;
      if (topicId && f.topic !== Number(topicId)) return;
      const topic = findTopic(f.topic);
      events.push({
        kind: "meeting",
        date: f.meta.meeting_date,
        topic_id: topic.id,
        topic_name: topic.name,
        title: f.meta.meeting_title || f.display_name,
      });
    });

    store.tasks.forEach((t) => {
      if (topicId && t.topic !== Number(topicId)) return;
      const topic = findTopic(t.topic);
      events.push({
        kind: "task",
        date: t.created_at.slice(0, 10),
        topic_id: topic.id,
        topic_name: topic.name,
        title: `Task added: ${t.title}`,
      });
      if (t.status === "done") {
        events.push({
          kind: "task-done",
          date: t.updated_at.slice(0, 10),
          topic_id: topic.id,
          topic_name: topic.name,
          title: `Task completed: ${t.title}`,
        });
      }
    });

    store.summaries.forEach((s) => {
      if (topicId && s.topic !== Number(topicId)) return;
      const topic = findTopic(s.topic);
      events.push({
        kind: "status",
        date: s.generated_at.slice(0, 10),
        topic_id: topic.id,
        topic_name: topic.name,
        title: (s.answer_summary || s.current_state || "Brief regenerated").trim().slice(0, 140),
      });
    });

    events.sort((a, b) => b.date.localeCompare(a.date));
    return events.slice(0, 200);
  },
  primeCsrf: async () => ({ ok: true }),
  login: async () => ({ ...store.user }),
  // Demo mode has one fixed user and no real account store, so "creating an
  // account" here just renames the existing demo user and signs them in -
  // same honest, no-fabrication approach as updateProfile() below, not a
  // simulation of a real multi-user signup.
  register: async (username, email, password, displayName) => {
    await wait();
    store.user.display_name = displayName || username || store.user.display_name;
    store.user.username = username || store.user.username;
    return { ...store.user };
  },
  requestPasswordReset: async () => {
    await wait();
    return { ok: true };
  },
  confirmPasswordReset: async () => {
    await wait();
    return { ok: true };
  },
  logout: async () => ({ ok: true }),
  me: async () => {
    await api.loadLocalProjects();
    return { ...store.user };
  },
  changePassword: async () => ({ ok: true }),
  updateProfile: async (displayName) => {
    await wait();
    store.user.display_name = displayName;
    return { ...store.user };
  },
};
