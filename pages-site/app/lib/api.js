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
import { findSupportingPassage } from "./evidence";
import {
  DOC_TYPE_LABELS,
  MEETING_TYPE_LABELS,
  TIMELINE_DOC_TYPES,
  csvPhase,
  displayTitle,
  ensureFileMeta,
  meetingTimelineTitle,
  normaliseTags,
  speakerSummary,
  tagList,
} from "./docMeta";
import { metadataCsv } from "./demoFiles";

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

// The excerpt shown for a content-matched search result - the plain text
// around wherever the first token appears (ported from the real backend's
// _search_snippet): collapsed to one line, ellipsized where it was cut.
function searchSnippet(text, tokens, context = 70) {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const tok of tokens) {
    pos = lower.indexOf(tok);
    if (pos !== -1) break;
  }
  if (pos === -1) return "";
  const start = Math.max(0, pos - context);
  const end = Math.min(text.length, pos + context);
  let snippet = text.slice(start, end).split(/\s+/).filter(Boolean).join(" ");
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet += "…";
  return snippet;
}

// Files a recording's transcript into a project, the way the real backend's
// _ingest_into_topic does (one IngestedFile row carrying the transcript text),
// so a project created from / assigned a recording shows a file straight away.
function ingestEventIntoTopic(ev, topic) {
  const now = new Date().toISOString();
  store.files.push({
    id: newId(),
    topic: topic.id,
    path: ev.file_name,
    display_name: ev.file_name,
    source_method: "folder",
    content_hash: "demo",
    extracted_text: ev.transcript_text || "",
    extraction_error: "",
    first_added_at: now,
    last_ingested_at: now,
    meta: null,
  });
}

export const DEMO_SETTINGS_PASSWORD = "demo";

function requireSettingsPassword(supplied) {
  if (supplied !== DEMO_SETTINGS_PASSWORD) {
    throw new Error('403 Forbidden: {"error": "The settings password is missing or wrong.", "code": "settings_password"}');
  }
}

function wait(ms = 220) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function topicBrief(t) {
  return { id: t.id, name: t.name, one_liner: t.one_liner, topic_type: t.topic_type };
}

// Meeting-side additions (type + sequence, who-said-what summary, notes).
// speaker_turns itself stays in the store; only the code-built summary and a
// count are exposed, like the real meeting serializer.
function meetingExtras(meta) {
  const turns = meta.speaker_turns || [];
  return {
    meeting_type: meta.meeting_type || "",
    meeting_type_label: MEETING_TYPE_LABELS[meta.meeting_type] || "",
    meeting_sequence: meta.meeting_sequence ?? null,
    meeting_type_source: meta.meeting_type_source || "",
    speaker_turn_count: turns.length,
    speaker_summary: speakerSummary(turns),
  };
}

function metaKeys(f) {
  ensureFileMeta(f);
  const tags = tagList(f.topic_tags);
  return {
    doc_type: f.doc_type,
    doc_type_label: DOC_TYPE_LABELS[f.doc_type] || "",
    doc_type_source: f.doc_type_source || "",
    // What the file IS ("Proposal V2"), shown ahead of its real file name.
    display_title: displayTitle(f),
    topic_tags: tags.join(", "),
    topic_tag_list: tags,
    signal: f.signal || "",
    meta_state: f.meta_state || "",
    review_notes: f.review_notes || "",
    version_label: f.version_label || "",
    document_date: f.document_date || null,
    meta_seconds: f.meta_seconds ?? null,
  };
}

function fileWithMeta(f) {
  const meta = f.meta
    ? (() => {
        const { speaker_turns, ...rest } = f.meta;
        return { ...rest, ...meetingExtras(f.meta) };
      })()
    : null;
  return {
    ...metaKeys(f),
    id: f.id,
    path: f.path,
    display_name: f.display_name,
    source_method: f.source_method,
    artifact_type: f.meta ? "meeting" : f.doc_type === "email" ? "email" : "file",
    content_hash: f.content_hash,
    extraction_error: f.extraction_error,
    // Fixture-only: lets the "Edit" link on a cited source open the sample
    // text in a read-only tab (the real API doesn't send this field).
    extracted_text: f.extracted_text || "",
    first_added_at: f.first_added_at,
    last_ingested_at: f.last_ingested_at,
    meta,
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
    stage: topic.stage || "",
    customer_name: topic.customer_name || "",
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

// The task shape the API returns: action items carry no due date.
function taskOut(t) {
  const { due_date, ...rest } = t;
  return { ...rest, topic_name: findTopic(t.topic)?.name || "" };
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
  const demoIds = new Set([1, 2, 3, 4]);
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
    feedback: "",
    created_at: new Date().toISOString(),
  });
}

function noteOut(n) {
  const f = n.meta ? store.files.find((x) => x.meta && x.meta.id === n.meta) : null;
  return {
    id: n.id,
    topic: n.topic,
    meta: n.meta,
    meeting_title: f?.meta?.meeting_title || "",
    meeting_date: f?.meta?.meeting_date || null,
    text: n.text,
    author: n.author,
    created_at: n.created_at,
  };
}

function meetingEntry(f) {
  return {
    id: f.meta.id,
    file_id: f.id,
    file_display_name: f.display_name,
    file_path: f.path,
    meeting_title: f.meta.meeting_title,
    timeline_title: meetingTimelineTitle(f.meta, f.display_name),
    meeting_date: f.meta.meeting_date,
    meeting_time: f.meta.meeting_time,
    attendees: f.meta.attendees,
    agenda: f.meta.agenda,
    achieved: f.meta.achieved,
    ...meetingExtras(f.meta),
    notes: store.notes.filter((n) => n.meta === f.meta.id).map(noteOut),
  };
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
      stage: data.stage || "",
      customer_name: data.customer_name || "",
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
    // Plain-text files are read in the browser so they become searchable;
    // everything else (and audio/video, which the full app transcribes
    // locally) is recorded as a file with no extracted text - nothing is
    // uploaded anywhere.
    const isText = /\.(txt|md|csv)$/i.test(file.name);
    const isMedia = /\.(mp4|mov|webm|wav|mp3|m4a)$/i.test(file.name);
    let extracted = "";
    if (isText) {
      try {
        extracted = await file.text();
      } catch {
        extracted = "";
      }
    } else if (isMedia) {
      extracted = "(Demo mode - audio/video is not transcribed in this static build.)";
    }
    store.files.push({
      id: newId(),
      topic: Number(topicId),
      path: file.name,
      display_name: file.name,
      source_method: "upload",
      content_hash: "demo",
      extracted_text: extracted,
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
      extracted_text: text || "",
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
  // Thumbs up/down on one assistant answer (value "up" | "down" | "" to
  // clear). Stored on the in-memory message only, so it resets on refresh
  // like every other edit in this demo.
  setMessageFeedback: async (kind, messageId, value) => {
    await wait(120);
    const m = store.messages.find((x) => x.id === Number(messageId));
    if (m) m.feedback = value || "";
    return { ok: true, feedback: value || "" };
  },
  uploadFolder: async (topicId) => {
    await wait(500);
    return { added: 0, updated: 0, unchanged: 0 };
  },
  getMeetingMetadata: async (topicId) => {
    await wait();
    return topicFiles(Number(topicId))
      .filter((f) => f.meta)
      .map(meetingEntry)
      .sort((a, b) => (b.meeting_date || "").localeCompare(a.meeting_date || ""));
  },
  // Meeting type + sequence (editable; marks it as set by a person) - the
  // demo counterpart of PATCH /meetings/<id>/.
  updateMeeting: async (metaId, fields) => {
    await wait(150);
    const f = store.files.find((x) => x.meta && x.meta.id === Number(metaId));
    if (!f) throw new Error("404 Not Found: no such meeting in this demo");
    const has = (k) => Object.prototype.hasOwnProperty.call(fields || {}, k);
    if (!has("meeting_type") && !has("meeting_sequence")) throw new Error("Send meeting_type and/or meeting_sequence.");
    if (has("meeting_type")) {
      if (fields.meeting_type && !MEETING_TYPE_LABELS[fields.meeting_type]) throw new Error("Unknown meeting type.");
      f.meta.meeting_type = fields.meeting_type || "";
    }
    if (has("meeting_sequence")) {
      const n = fields.meeting_sequence;
      if (n !== null && (!Number.isInteger(n) || n < 1 || n > 99)) {
        throw new Error("Meeting sequence must be a whole number from 1 to 99.");
      }
      f.meta.meeting_sequence = n;
    }
    f.meta.meeting_type_source = "manual";
    return meetingEntry(f);
  },
  // File metadata edit / confirm - demo counterparts of PATCH /files/<id>/metadata/
  // and POST /files/<id>/confirm/ (same rules: only changed fields count, and a
  // review-note-only edit does not flip the state to "corrected").
  updateFileMetadata: async (fileId, fields) => {
    await wait(150);
    const f = store.files.find((x) => x.id === Number(fileId));
    if (!f) throw new Error("404 Not Found: no such file in this demo");
    ensureFileMeta(f);
    const has = (k) => Object.prototype.hasOwnProperty.call(fields || {}, k);
    const editable = ["doc_type", "topic_tags", "signal", "version_label", "document_date", "review_notes"];
    if (!editable.some(has)) throw new Error(`Send at least one of: ${editable.join(", ")}`);
    let corrected = false;
    if (has("doc_type")) {
      if (!DOC_TYPE_LABELS[fields.doc_type]) throw new Error("Unknown document type.");
      f.doc_type = fields.doc_type;
      f.doc_type_source = "manual";
      corrected = true;
    }
    if (has("topic_tags")) {
      f.topic_tags = normaliseTags(fields.topic_tags).join(", ");
      corrected = true;
    }
    if (has("signal")) {
      f.signal = String(fields.signal || "").trim().slice(0, 400);
      corrected = true;
    }
    if (has("version_label")) {
      f.version_label = String(fields.version_label || "").trim().slice(0, 30);
      corrected = true;
    }
    if (has("document_date")) {
      const d = fields.document_date;
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("document_date must be YYYY-MM-DD.");
      f.document_date = d || null;
      corrected = true;
    }
    if (has("review_notes")) f.review_notes = String(fields.review_notes || "");
    if (corrected) f.meta_state = "corrected";
    return { id: f.id, topic_id: f.topic, ...metaKeys(f) };
  },
  confirmFileMetadata: async (fileId) => {
    await wait(150);
    const f = store.files.find((x) => x.id === Number(fileId));
    if (!f) throw new Error("404 Not Found: no such file in this demo");
    ensureFileMeta(f);
    if (f.meta_state === "error" || f.extraction_error) {
      throw new Error("This file could not be read, so there is nothing to confirm.");
    }
    if (f.meta_state === "generated_unconfirmed" || !f.meta_state) f.meta_state = "confirmed";
    return { id: f.id, topic_id: f.topic, ...metaKeys(f) };
  },
  // Per-meeting human notes (high-signal, shown on the timeline).
  getNotes: async (topicId) => {
    await wait(100);
    return store.notes.filter((n) => n.topic === Number(topicId)).map(noteOut);
  },
  addNote: async (topicId, text, metaId) => {
    await wait(150);
    const clean = String(text || "").trim();
    if (!clean) throw new Error("text is required");
    if (clean.length > 2000) throw new Error("That note is too long (2000 characters max).");
    const note = {
      id: newId(),
      topic: Number(topicId),
      meta: metaId ? Number(metaId) : null,
      text: clean,
      author: store.user.username,
      created_at: new Date().toISOString(),
    };
    store.notes.push(note);
    return noteOut(note);
  },
  deleteNote: async (topicId, noteId) => {
    await wait(120);
    store.notes = store.notes.filter((n) => !(n.id === Number(noteId) && n.topic === Number(topicId)));
    return null;
  },
  // Business events for the topic timeline (emails, key documents, notes),
  // oldest first - same item shape as the real /timeline_events/ endpoint.
  getTimelineEvents: async (topicId) => {
    await wait(120);
    const tid = Number(topicId);
    const events = [];
    const blank = {
      approx_date: false,
      file_id: null,
      meta_id: null,
      note_id: null,
      doc_type: "",
      version_label: "",
      meeting_type: "",
      meeting_sequence: null,
      author: "",
      meeting_title: "",
    };
    for (const f of topicFiles(tid)) {
      ensureFileMeta(f);
      if (f.meta_state === "error" || f.extraction_error) continue;
      if (f.meta?.meeting_date) {
        events.push({
          ...blank,
          kind: "meeting",
          date: f.meta.meeting_date,
          title: meetingTimelineTitle(f.meta, f.display_name),
          body: f.meta.achieved || f.meta.agenda || "",
          file_id: f.id,
          meta_id: f.meta.id,
          meeting_type: f.meta.meeting_type || "",
          meeting_sequence: f.meta.meeting_sequence ?? null,
        });
      }
      const date = f.document_date || (f.first_added_at || "").slice(0, 10);
      const approx = !f.document_date;
      if (f.doc_type === "email") {
        events.push({ ...blank, kind: "email", date, approx_date: approx, title: f.subject || f.display_name, body: f.signal || "", file_id: f.id, doc_type: "email" });
      } else if (TIMELINE_DOC_TYPES.includes(f.doc_type)) {
        const label = DOC_TYPE_LABELS[f.doc_type];
        events.push({
          ...blank,
          kind: "document",
          date,
          approx_date: approx,
          title: f.version_label ? `${label} ${f.version_label}` : label,
          body: f.signal || "",
          file_id: f.id,
          doc_type: f.doc_type,
          version_label: f.version_label || "",
        });
      }
    }
    for (const n of store.notes.filter((x) => x.topic === tid)) {
      const mf = n.meta ? store.files.find((x) => x.meta && x.meta.id === n.meta) : null;
      events.push({
        ...blank,
        kind: "note",
        date: n.created_at,
        title: `Note: ${n.text.split(/\s+/).slice(0, 8).join(" ")}`,
        body: n.text,
        note_id: n.id,
        meta_id: n.meta,
        author: n.author,
        meeting_title: mf?.meta?.meeting_title || "",
      });
    }
    return events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  },
  // "Export metadata CSV" - built in the browser from the fixture store (the
  // real app serves it from /topics/<id>/metadata_csv/). The first 7 columns
  // are the contract columns, in order; phase/version/doc_date/participants
  // follow.
  getMetadataCsv: async (topicId) => {
    await wait(100);
    const topic = findTopic(topicId);
    const rows = topicFiles(Number(topicId)).map((f) => {
      ensureFileMeta(f);
      const isErr = f.meta_state === "error" || !!f.extraction_error;
      return {
        file: f.path,
        document_type: DOC_TYPE_LABELS[f.doc_type] || "",
        topic_tags: tagList(f.topic_tags).join(", "),
        signal: f.signal || "",
        state: isErr ? "error" : f.meta_state || "",
        seconds: (f.meta_seconds ?? 0).toFixed(1),
        review_notes: f.review_notes || (isErr ? f.extraction_error : ""),
        phase: csvPhase(topic, f),
        version: f.version_label || "",
        doc_date: f.document_date || f.meta?.meeting_date || "",
        participants: (f.meta ? f.meta.attendees : f.participants || []).join("; "),
      };
    });
    rows.sort((a, b) => (a.doc_date ? 0 : 1) - (b.doc_date ? 0 : 1) || a.doc_date.localeCompare(b.doc_date));
    const base = (topic?.name || "project").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "project";
    return { filename: `${base}-metadata.csv`, csv: metadataCsv(rows) };
  },
  // Topic edit (Stage / Customer name) - in-memory like every other edit.
  updateTopic: async (id, fields) => {
    await wait(150);
    const topic = findTopic(id);
    if (!topic) throw new Error("404 Not Found: no such project in this demo");
    const stages = ["", "intro", "discovery", "solution", "commercial", "won", "lost", "delivery"];
    if (Object.prototype.hasOwnProperty.call(fields, "stage")) {
      if (!stages.includes(fields.stage || "")) throw new Error("Unknown stage.");
      topic.stage = fields.stage || "";
    }
    if (Object.prototype.hasOwnProperty.call(fields, "customer_name")) {
      topic.customer_name = String(fields.customer_name || "").slice(0, 200);
    }
    saveLocalProjects();
    return topicListItem(topic);
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
        meeting_type: f.meta.meeting_type || "",
        meeting_sequence: f.meta.meeting_sequence ?? null,
      });
    });
    // Action items have no due date, so the calendar shows meetings only.
    return events.sort((a, b) => b.date.localeCompare(a.date));
  },
  getTasks: async (topicId) => {
    await wait();
    return store.tasks.filter((t) => !topicId || t.topic === Number(topicId)).map(taskOut);
  },
  createTask: async (topicId, { title, assignee }) => {
    await wait();
    const task = {
      id: newId(),
      topic: Number(topicId),
      source_file: null,
      title,
      assignee: assignee || "",
      due_date: null,
      status: "backlog",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.tasks.push(task);
    return taskOut(task);
  },
  updateTask: async (taskId, fields) => {
    await wait();
    const task = store.tasks.find((t) => t.id === Number(taskId));
    if (!task) throw new Error("404 Not Found");
    Object.assign(task, fields, { updated_at: new Date().toISOString() });
    return taskOut(task);
  },
  deleteTask: async (taskId) => {
    await wait();
    store.tasks = store.tasks.filter((t) => t.id !== Number(taskId));
    return null;
  },
  // Where an action item came from: its file (template name first, real name
  // second) and the closest-matching passage of it - the demo's stand-in for
  // the real app's GET /api/tasks/<id>/source/.
  getTaskSource: async (taskId) => {
    await wait(120);
    const task = store.tasks.find((t) => t.id === Number(taskId));
    if (!task) throw new Error("404 Not Found");
    const f = task.source_file ? store.files.find((x) => x.id === Number(task.source_file)) : null;
    if (!f) return { added_by_hand: true, file: null, passage: null };
    ensureFileMeta(f);
    return {
      added_by_hand: false,
      file: {
        id: f.id,
        name: f.display_name || f.path,
        label: displayTitle(f),
        doc_type: f.doc_type,
        read_by_ai: f.doc_type_source === "llm",
        meeting_title: f.meta?.meeting_title || "",
        date: f.meta?.meeting_date || f.document_date || String(f.first_added_at || "").slice(0, 10),
        openable: true,
        // Fixture-only: lets "Open file" show the sample text in a read-only tab.
        display_name: f.display_name,
        path: f.path,
        extracted_text: f.extracted_text || "",
      },
      passage: findSupportingPassage(f, task.title),
    };
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
  // The real app checks a settings password on every save. The demo has no
  // backend, so this plays that part with a published demo password (the real
  // password is never in the repository).
  unlockSettings: async (settingsPassword) => {
    await wait(150);
    requireSettingsPassword(settingsPassword);
    return { ok: true };
  },
  saveSettings: async (data, settingsPassword) => {
    await wait();
    requireSettingsPassword(settingsPassword);
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
      if (t) ingestEventIntoTopic(ev, t);
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
    ingestEventIntoTopic(ev, topic);
    return ev;
  },
  // The manual counterpart to confirmNewProject - a person deciding that a
  // recording (or dropped file) deserves its own project, from any status.
  // Requires an explicit name, same as the real endpoint.
  createProjectFromRecording: async (eventId, fields = {}) => {
    await wait();
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    if (!ev) throw new Error("404 Not Found: no such recording in this demo");
    const name = (fields.name || "").trim();
    if (!name) throw new Error("A project name is required.");
    const topic = {
      id: newId(),
      name: name.slice(0, 200),
      topic_type: (fields.topic_type || "").trim() || "project",
      one_liner: (fields.one_liner || "").trim().slice(0, 300),
      related_people: "",
      created_at: new Date().toISOString(),
    };
    store.topics.push(topic);
    ev.topic = topic.id;
    ev.topic_name = topic.name;
    ev.status = "auto_created";
    ev.detail = "New project created from this recording.";
    ingestEventIntoTopic(ev, topic);
    return { ...ev };
  },
  // The corner "x" on a pending card - never a hard delete, the row stays
  // with status "dismissed" so it stops showing in any needs-review list.
  dismissRecordingEvent: async (eventId) => {
    await wait(120);
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    if (!ev) throw new Error("404 Not Found: no such recording in this demo");
    ev.status = "dismissed";
    ev.detail = "Dismissed - not tracked.";
    return { ...ev };
  },
  bulkDismissRecordingEvents: async (eventIds) => {
    await wait(150);
    const ids = new Set((eventIds || []).map(Number));
    if (ids.size === 0) throw new Error("event_ids is required");
    let count = 0;
    for (const ev of store.recordingEvents) {
      if (!ids.has(ev.id)) continue;
      ev.status = "dismissed";
      ev.detail = "Dismissed - not tracked.";
      count += 1;
    }
    return { dismissed_count: count };
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
    return { ...ev, speaker_turn_count: (ev.speaker_turns || []).length };
  },
  // Rename a speaker in the Conversation view (renamed turns are marked
  // edited; renaming to an existing label merges the two) - in-memory only.
  renameRecordingSpeaker: async (eventId, oldName, newName) => {
    await wait(150);
    const ev = store.recordingEvents.find((e) => e.id === Number(eventId));
    if (!ev) throw new Error("404 Not Found: no such recording in this demo");
    const from = String(oldName || "").trim();
    const to = String(newName || "").trim();
    if (!from || !to) throw new Error("Both the old and the new speaker name are required.");
    if (to.length > 60) throw new Error("The new name is too long (60 characters max).");
    const hit = (ev.speaker_turns || []).filter((t) => t.speaker === from);
    if (hit.length === 0) throw new Error(`No turns are labelled '${from}'.`);
    hit.forEach((t) => {
      t.speaker = to;
      t.edited = true;
    });
    if (ev.speaker_transcript) {
      ev.speaker_transcript = ev.speaker_transcript
        .split("\n")
        .map((line) => (line.includes(`] ${from}:`) ? line.replace(`] ${from}:`, `] ${to}:`) : line))
        .join("\n");
    }
    return { ...ev, speaker_turn_count: ev.speaker_turns.length, renamed_turns: hit.length };
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
    if (!ev.topic) throw new Error("Assign this recording to a project before saving its summary.");
    // The real app writes a .md file into the project's own folder; the demo
    // has no disk, so this reports the fictional path it would have used.
    const stem = ev.file_name.replace(/\.[^.]+$/, "");
    return { saved_to: `C:\\Demo\\${ev.topic_name}\\${stem} - Summary.md`, summary_generated_at: ev.summary_generated_at };
  },
  // Universal search (Ctrl/Cmd+K) - mirrors the real backend's GlobalSearchView
  // (core/views.py): the query is split into tokens, every token must appear
  // somewhere in the searched fields (any order), each group is capped at 8.
  // Plain substring checks over the fixture store, no model call. Groups:
  // projects (name/one-liner/related people, with file_count + last_indexed),
  // stakeholders ("People" - meeting attendees, grouped by name with the
  // projects they appear in), topics (content matches inside a file's
  // extracted text, with a real excerpt), files (filename matches), tasks.
  search: async (q) => {
    await wait(150);
    const tokens = (q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const empty = { projects: [], stakeholders: [], topics: [], files: [], tasks: [] };
    if (tokens.length === 0) return empty;
    const matchAll = (...fields) =>
      tokens.every((tok) => fields.some((f) => (f || "").toLowerCase().includes(tok)));
    const latestIndexed = (files) =>
      files.length ? files.map((f) => f.last_ingested_at).sort().slice(-1)[0] : null;

    const projects = store.topics
      .filter((t) => matchAll(t.name, t.one_liner, t.related_people))
      .slice(0, 8)
      .map((t) => {
        const files = topicFiles(t.id);
        return { ...topicBrief(t), file_count: files.length, last_indexed: latestIndexed(files) };
      });

    const people = new Map();
    for (const f of store.files) {
      for (const name of f.meta?.attendees || []) {
        const lname = name.toLowerCase();
        if (!tokens.every((tok) => lname.includes(tok))) continue;
        const entry = people.get(lname) || { name, projects: [] };
        if (!entry.projects.some((p) => p.topic_id === f.topic)) {
          entry.projects.push({ topic_id: f.topic, topic_name: findTopic(f.topic)?.name || "" });
        }
        people.set(lname, entry);
      }
    }
    const stakeholders = [...people.values()].slice(0, 8);

    const tasks = store.tasks
      .filter((t) => matchAll(t.title))
      .slice(0, 8)
      .map((t) => ({ id: t.id, title: t.title, topic_id: t.topic, topic_name: findTopic(t.topic)?.name || "" }));

    const fileRow = (f) => ({
      id: f.id,
      display_name: f.display_name || f.path,
      topic_id: f.topic,
      topic_name: findTopic(f.topic)?.name || "",
      last_indexed: f.last_ingested_at,
    });
    const files = store.files.filter((f) => matchAll(f.display_name)).slice(0, 8).map(fileRow);
    const topics = store.files
      .filter((f) => f.extracted_text && matchAll(f.extracted_text))
      .slice(0, 8)
      .map((f) => ({ ...fileRow(f), snippet: searchSnippet(f.extracted_text, tokens) }));

    return { projects, stakeholders, topics, files, tasks };
  },
  // Fire-and-forget in the real app (records each search outcome server-side
  // for review). Nothing to log to here - the demo has no backend - so it
  // resolves immediately and stores nothing.
  logSearchOutcome: async () => ({ ok: true }),
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
          artifact_type: f.meta ? "meeting" : f.doc_type === "email" ? "email" : "file",
          first_added_at: f.first_added_at,
          ...metaKeys(f),
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
        title: meetingTimelineTitle(f.meta, f.display_name),
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
  // One shared login: sign-up and email password reset do not exist.
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
