// Document-metadata helpers for the static demo (additive, browser-only).
// Mirrors the real app's plain-code classifier in spirit (filename/content
// keywords -> doc type, version label from the filename, signal = one
// sentence) so files that are uploaded or pasted during a demo session get
// the same chips as the fixture files. No model call, nothing leaves the
// browser. Everything produced here is "generated_unconfirmed" until a person
// confirms or edits it - the same "never invent facts" rule as the real app.

export const DOC_TYPE_LABELS = {
  email: "Email",
  meeting_transcript: "Meeting Transcript",
  mom_action_items: "MoM / Action Items",
  proposal: "Proposal",
  quotation_sow: "Quotation / SOW",
  prd_brd: "PRD / BRD",
  project_charter: "Project Charter",
  project_plan: "Project Plan",
  opportunity_scorecard: "Opportunity Scorecard",
  stakeholder_map: "Stakeholder Map",
  report: "Report",
  notes: "Notes",
  other: "Other",
};

export const MEETING_TYPE_LABELS = {
  intro: "Intro",
  discovery: "Discovery",
  solution: "Solution",
  commercial: "Commercial",
  kickoff: "Kickoff",
  review: "Review",
  standup: "Stand-up",
  other: "Other",
};

// Document types that become their own event on the topic timeline.
export const TIMELINE_DOC_TYPES = ["proposal", "quotation_sow", "prd_brd", "project_charter", "project_plan", "opportunity_scorecard"];

const DELIVERY_DOC_TYPES = ["prd_brd", "project_charter", "project_plan", "stakeholder_map"];
const DELIVERY_MEETING_TYPES = ["kickoff", "standup", "review"];

export function classifyDocType(name, text, hasMeeting) {
  const n = (name || "").toLowerCase();
  if (/\.(eml|msg)$/.test(n)) return "email";
  if (hasMeeting) return "meeting_transcript";
  if (/score[ _-]?card/.test(n)) return "opportunity_scorecard";
  if (/quotation|quote|\bsow\b/.test(n)) return "quotation_sow";
  if (/proposal/.test(n)) return "proposal";
  if (/\b(prd|brd)\b/.test(n)) return "prd_brd";
  if (/charter/.test(n)) return "project_charter";
  if (/project[ _-]?plan/.test(n)) return "project_plan";
  if (/stakeholder/.test(n)) return "stakeholder_map";
  if (/minutes|\bmom\b|action[ _-]?items/.test(n)) return "mom_action_items";
  if (/notes?\b/.test(n)) return "notes";
  if (/guideline|report|review/.test(n)) return "report";
  if (/^\s*(from|subject):/im.test(text || "")) return "email";
  return "other";
}

// What a file IS, not what it is called: "<type name> <version>" (e.g.
// "Proposal V2"). Notes, "other" and untyped files keep their own file name.
export function displayTitle(f) {
  const label = DOC_TYPE_LABELS[f.doc_type];
  const name = String(f.display_name || f.path || "").split(/[\\/]/).pop();
  if (!label || f.doc_type === "notes" || f.doc_type === "other") return name;
  return `${label} ${f.version_label || ""}`.trim();
}

export function versionFromName(name) {
  const n = (name || "").toLowerCase();
  const v = /[ _-]v(\d{1,2})(?![a-z0-9])/.exec(n);
  if (v) return `V${v[1]}`;
  if (/[ _-]final(?![a-z])/.test(n)) return "Final";
  return "";
}

function firstSentence(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const m = /^(.{20,200}?[.!?])(\s|$)/.exec(clean);
  return (m ? m[1] : clean.slice(0, 200)).trim();
}

// Fills in the metadata keys on a store file row (only when none are set yet,
// and never over a human value).
export function ensureFileMeta(f) {
  if (f.doc_type !== undefined) return f;
  const doc_type = classifyDocType(f.display_name || f.path, f.extracted_text, !!f.meta);
  f.doc_type = doc_type;
  f.doc_type_source = "auto";
  f.topic_tags = f.topic_tags || "";
  f.signal = f.signal || (f.meta?.achieved ? f.meta.achieved.slice(0, 200) : firstSentence(f.extracted_text));
  f.meta_state = f.extraction_error ? "error" : "generated_unconfirmed";
  f.review_notes = f.review_notes || "";
  f.version_label = f.version_label ?? versionFromName(f.display_name || f.path);
  f.document_date = f.document_date ?? null;
  f.meta_seconds = f.meta_seconds ?? 0.1;
  return f;
}

export function tagList(str) {
  return (str || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

// Contract section 3: normalise to at most 3 unique tags.
export function normaliseTags(input) {
  const arr = Array.isArray(input) ? input : tagList(input);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const t = String(raw).trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === 3) break;
  }
  return out;
}

// "Discovery 2: <title>" for a typed meeting; untyped meetings keep their title.
export function meetingTimelineTitle(meta, fallback) {
  const title = meta?.meeting_title || fallback || "";
  if (!meta?.meeting_type) return title;
  const label = MEETING_TYPE_LABELS[meta.meeting_type] || meta.meeting_type;
  const seq = meta.meeting_sequence;
  const prefix = seq ? `${label} ${seq}` : label;
  if (title.toLowerCase().includes(prefix.toLowerCase())) return title;
  return `${prefix}: ${title}`;
}

// Code-only per-speaker summary (turns, words, first substantive lines).
export function speakerSummary(turns) {
  const by = new Map();
  for (const t of turns || []) {
    const e = by.get(t.speaker) || { speaker: t.speaker, turns: 0, words: 0, first_lines: [] };
    e.turns += 1;
    e.words += (t.text || "").split(/\s+/).filter(Boolean).length;
    if (e.first_lines.length < 3 && (t.text || "").split(/\s+/).length >= 6) e.first_lines.push(t.text);
    by.set(t.speaker, e);
  }
  return [...by.values()].sort((a, b) => b.turns - a.turns || b.words - a.words);
}

// CSV phase column (contract section 4).
export function csvPhase(topic, file) {
  const dt = file.doc_type;
  const mt = file.meta?.meeting_type;
  if (DELIVERY_DOC_TYPES.includes(dt) || DELIVERY_MEETING_TYPES.includes(mt)) return "Delivery";
  if (topic.topic_type === "opportunity" || topic.topic_type === "customer" || topic.stage) return "Pre-sales";
  return "";
}
