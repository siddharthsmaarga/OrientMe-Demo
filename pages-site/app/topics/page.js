"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  formatAdded,
  formatMeetingDate,
  formatRelativeDay,
  formatTimeAgo,
  projectUrgency,
  taskUrgency,
  TYPE_LABELS,
  TYPE_STYLES,
  URGENCY_STYLES,
} from "../lib/format";
import CalendarWidget from "../components/CalendarWidget";
import ProjectTabs from "../components/ProjectTabs";
import TaskBoard from "../components/TaskBoard";
import {
  briefHtmlPage,
  briefMarkdown,
  downloadText,
  openInNewTab,
  openSourceFile,
  summaryCsv,
  tasksCsv,
} from "../lib/demoFiles";

const PROJECT_TABS = [
  { key: "overview", label: "Overview" },
  { key: "work", label: "Action Items" },
  { key: "commitments", label: "Commitments" },
  { key: "decisions", label: "Decisions" },
  { key: "meetings", label: "Meetings" },
  { key: "risks", label: "Risks" },
];

const FETCH_TABS = [
  { key: "folder", label: "Lookup folder" },
  { key: "upload", label: "Upload file" },
  { key: "folderUpload", label: "Upload folder" },
  { key: "paste", label: "Paste text" },
  { key: "more", label: "More sources" },
];

// The 5 sections a CaseSummary fills in only for a specific kind of
// question (see llm_brief.py's prompt rule) - meeting_prep only for "help me
// prepare for..." asks, latest_updates only for "what's changed" asks, etc.
// Rendered in ContextBriefPanel only when the field actually has content, so
// a routine question never shows five empty-feeling headers ("make it
// dynamic... automatically add according to the prompt").
const DYNAMIC_SECTION_FIELDS = [
  { key: "customer_need", icon: "🧩", label: "Customer need" },
  { key: "proposed_solution", icon: "💡", label: "Proposed solution" },
  { key: "decisions_made", icon: "✅", label: "Decisions made" },
  { key: "latest_updates", icon: "🆕", label: "Latest updates" },
  { key: "meeting_prep", icon: "📋", label: "Meeting prep" },
];

// One-click preset questions (spec's "Smart Suggestions") - each just
// regenerates the SAME on-page brief via the existing refresh_summary
// endpoint with a different question, exactly like the "↻ Refresh" button
// already does. Deliberately NOT a chat input - a free-text ask box was
// removed from this page per direct product feedback (see the comment
// further down where the reading column starts).
const SMART_SUGGESTIONS = [
  {
    key: "catchup",
    label: "Catch me up",
    question: "Catch me up on this project — what's the current state and what's changed recently?",
  },
  { key: "changed", label: "What's changed?", question: "What's changed since last time?" },
  {
    key: "meeting_prep",
    label: "Prepare me for next meeting",
    question: "Help me prepare for my next meeting on this project.",
  },
];

const SOURCE_METHOD_LABELS = {
  folder: "Lookup folder",
  upload: "Uploaded",
  folder_upload: "Uploaded folder",
  paste: "Pasted",
};

// Shared real-time progress bar for every bulk data-fetch action (scan,
// folder upload, mbox/ics import) - each backend action runs the same
// ScanJob-backed background job, so one component covers all of them.
function BulkJobProgress({ busy, job }) {
  if (!busy || !job) return null;
  const pct =
    job.total_files > 0
      ? Math.min(100, (job.processed_files / job.total_files) * 100)
      : job.status === "scanning"
        ? 15
        : 50;
  return (
    <div className="mt-2">
      <p className="text-[11px] text-slate-500 mb-1">
        {job.status === "scanning" ? "Reading files…" : "Extracting details…"}
        {job.total_files > 0 && ` (${job.processed_files}/${job.total_files})`}
      </p>
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function TopicDetailPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-slate-500">Loading project…</div>}>
      <TopicDetailContent />
    </Suspense>
  );
}

function UploadIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#0096af"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mx-auto"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function nameWords(name) {
  return name.toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Same person gets named inconsistently across different transcripts/
// speaker labels - "Person A", "Person A Smith", "Person A Smith Jr." (sample
// bug: all three showed up as separate stakeholders). A shorter name whose
// every word appears in a longer name is the same person named less fully -
// keep only the longest (most complete) version. Whole-word matching (not
// substring) so distinct people with similar names never
// collapse into each other.
function dedupeNames(names) {
  const unique = Array.from(new Set(names));
  const sorted = [...unique].sort((a, b) => nameWords(b).length - nameWords(a).length);
  const kept = [];
  for (const name of sorted) {
    const words = nameWords(name);
    const coveredByExisting = kept.some((k) => words.every((w) => nameWords(k).includes(w)));
    if (!coveredByExisting) kept.push(name);
  }
  return kept;
}

// Shared by StakeholdersCard and the Export action, so the two never drift -
// the union of every meeting's real attendees (ExtractedMeta, already
// computed) plus the topic's own free-text related_people field, deduped.
function collectStakeholders(meetingMetadata, relatedPeople) {
  const names = new Set();
  meetingMetadata.forEach((m) => (m.attendees || []).forEach((a) => a && names.add(a)));
  (relatedPeople || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((n) => names.add(n));
  return dedupeNames(Array.from(names));
}

// Same palette + deterministic-by-name selection as the backend's
// _avatar_style (views.py) - kept in lockstep so a stakeholder's avatar
// color matches whether they're viewed here or on the HTML brief page.
const AVATAR_PALETTE = ["#0096af", "#7c5cbf", "#d0811c", "#3a8f5f", "#c0517a", "#5a6b8c"];

function avatarStyle(name) {
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  const color = AVATAR_PALETTE[sum % AVATAR_PALETTE.length];
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
  return { color, initials };
}

function fileDisplayName(entry) {
  // Backend may nest this under "file" ({display_name, path}) or return it
  // flat as "file_display_name"/"file_path" (its actual current shape) -
  // check all of them, plus a bare "display_name"/"path", rather than assume
  // one exact shape.
  const raw =
    entry.file?.display_name ||
    entry.file_display_name ||
    entry.display_name ||
    entry.file?.path ||
    entry.file_path ||
    entry.path ||
    "";
  return raw.split(/[\\/]/).pop() || "Untitled file";
}

function TopicDetailContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  // The project-level tab (Overview | Work | Commitments | ...) - synced to
  // a `?tab=` query param so each tab stays a shareable URL, without a
  // bigger Next.js routing change (no new routes/layouts). Named distinctly
  // from `activeTab` below (the unrelated "Manage sources" modal's own
  // fetch-method tab) to avoid confusing the two.
  const [projectTab, setProjectTab] = useState(() => searchParams.get("tab") || "overview");

  function selectProjectTab(key) {
    setProjectTab(key);
    router.replace(`${pathname}?id=${encodeURIComponent(id)}&tab=${key}`, { scroll: false });
  }

  const [topic, setTopic] = useState(null);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("folder");

  const [newFolder, setNewFolder] = useState("");
  const [addingFolder, setAddingFolder] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestResult, setIngestResult] = useState(null);
  const [scanJob, setScanJob] = useState(null);
  const autoScannedRef = useRef(false);
  const [newFilesBanner, setNewFilesBanner] = useState(null);

  const [uploading, setUploading] = useState(false);
  const [dragOverUpload, setDragOverUpload] = useState(false);
  const fileInputRef = useRef(null);

  const folderDirInputRef = useRef(null);
  const [uploadingFolder, setUploadingFolder] = useState(false);
  const [folderUploadResult, setFolderUploadResult] = useState(null);

  const mboxInputRef = useRef(null);
  const [importingMbox, setImportingMbox] = useState(false);
  const [mboxResult, setMboxResult] = useState(null);

  const icsInputRef = useRef(null);
  const [importingIcs, setImportingIcs] = useState(false);
  const [icsResult, setIcsResult] = useState(null);

  const [pasteLabel, setPasteLabel] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasting, setPasting] = useState(false);

  const [meetingMetadata, setMeetingMetadata] = useState([]);

  const [payrollRuns, setPayrollRuns] = useState([]);
  const [computingPayroll, setComputingPayroll] = useState(false);

  const [calendarEvents, setCalendarEvents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [commitments, setCommitments] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [risks, setRisks] = useState([]);
  const [projectState, setProjectState] = useState(null);
  const [editProjectOpen, setEditProjectOpen] = useState(false);

  const [summary, setSummary] = useState(null);
  const [refreshingSummary, setRefreshingSummary] = useState(false);
  const [summaryHistory, setSummaryHistory] = useState([]);
  const [workflowHistory, setWorkflowHistory] = useState([]);

  // "Manage sources" (the old "Add data" + "Ingested" sections) lives in its
  // own popup now, off the main canvas entirely - opened via the header's
  // "Manage sources" button, or automatically the first time a topic has no
  // files yet (see the effect below).
  const [sourcesModalOpen, setSourcesModalOpen] = useState(false);
  const [calendarModalOpen, setCalendarModalOpen] = useState(false);

  const tasksCsvInputRef = useRef(null);
  const [importingTasksCsv, setImportingTasksCsv] = useState(false);
  const summaryCsvInputRef = useRef(null);
  const [importingSummaryCsv, setImportingSummaryCsv] = useState(false);
  // The 6 export/import actions (2 markdown snapshots, 2 CSV export/import
  // pairs) were previously 6 separate header buttons - real clutter, called
  // out directly by a person actually using the page. Collapsed into one
  // menu; nothing removed, all 6 still reachable, just not all visible at
  // once (the header now matches Calendar/Manage sources' single-button
  // shape instead of standing out as a wall of buttons).
  const [dataMenuOpen, setDataMenuOpen] = useState(false);
  const dataMenuRef = useRef(null);
  useEffect(() => {
    function handleClickOutside(e) {
      if (dataMenuRef.current && !dataMenuRef.current.contains(e.target)) setDataMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function load() {
    try {
      setTopic(await api.getTopic(id));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadMeetingMetadata() {
    try {
      setMeetingMetadata(await api.getMeetingMetadata(id));
    } catch (e) {
      console.error("Could not load meeting metadata:", e.message);
    }
  }

  async function loadCalendar() {
    try {
      setCalendarEvents(await api.getCalendar(id));
    } catch (e) {
      console.error("Could not load calendar:", e.message);
    }
  }

  async function loadTasks() {
    try {
      setTasks(await api.getTasks(id));
    } catch (e) {
      console.error("Could not load tasks:", e.message);
    }
  }

  async function loadCommitments() {
    try {
      setCommitments(await api.getCommitments(id));
    } catch (e) {
      console.error("Could not load commitments:", e.message);
    }
  }

  async function loadDecisions() {
    try {
      setDecisions(await api.getDecisions(id));
    } catch (e) {
      console.error("Could not load decisions:", e.message);
    }
  }

  async function loadRisks() {
    try {
      setRisks(await api.getRisks(id));
    } catch (e) {
      console.error("Could not load risks:", e.message);
    }
  }

  async function loadProjectState() {
    try {
      setProjectState(await api.getProjectState(id));
    } catch (e) {
      console.error("Could not load project state:", e.message);
    }
  }

  async function handleSaveProjectState(currentPosition) {
    const state = await api.updateProjectState(id, currentPosition);
    setProjectState(state);
  }

  async function handleImportTasksCsv(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportingTasksCsv(true);
    try {
      const result = await api.importTasksCsv(id, file);
      alert(`Updated ${result.updated} task${result.updated === 1 ? "" : "s"}${result.skipped ? `, skipped ${result.skipped} row(s) with no matching task id` : ""}.`);
      loadTasks();
    } catch (e) {
      setError(e.message);
    } finally {
      setImportingTasksCsv(false);
      if (tasksCsvInputRef.current) tasksCsvInputRef.current.value = "";
    }
  }

  async function handleImportSummaryCsv(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportingSummaryCsv(true);
    try {
      const result = await api.importSummaryCsv(id, file);
      alert(`Brief updated (${result.updated} field${result.updated === 1 ? "" : "s"})${result.skipped ? `, skipped ${result.skipped} unrecognized row(s)` : ""}.`);
      loadSummary();
      loadSummaryHistory(); // the edit is a new row - show it on the timeline too
    } catch (e) {
      setError(e.message);
    } finally {
      setImportingSummaryCsv(false);
      if (summaryCsvInputRef.current) summaryCsvInputRef.current.value = "";
    }
  }

  async function loadSummary() {
    try {
      const s = await api.getLatestSummary(id);
      setSummary(s && s.generated_at ? s : null);
    } catch (e) {
      console.error("Could not load context brief:", e.message);
    }
  }

  async function loadSummaryHistory() {
    try {
      setSummaryHistory(await api.getSummaryHistory(id));
    } catch (e) {
      console.error("Could not load status-update history:", e.message);
    }
  }

  async function loadWorkflowHistory() {
    try {
      setWorkflowHistory(await api.getWorkflowHistory(id));
    } catch (e) {
      console.error("Could not load payroll-run history:", e.message);
    }
  }

  async function refreshExtras() {
    loadMeetingMetadata();
    loadCalendar();
    loadTasks();
    loadCommitments();
    loadDecisions();
    loadRisks();
    loadProjectState();
    loadSummary();
    loadSummaryHistory();
    loadWorkflowHistory();
  }

  useEffect(() => {
    load();
    refreshExtras();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // question is optional - the Smart Suggestions preset buttons pass their
  // own fixed question through; the plain "↻ Refresh" button calls this
  // with none, falling back to the backend's own default question.
  async function handleRefreshSummary(question) {
    setRefreshingSummary(true);
    try {
      const s = await api.refreshSummary(id, question);
      setSummary(s);
      loadSummaryHistory(); // so the new status update shows up on the timeline right away
      load(); // the refresh also lands as a chat turn - pull it into the chat panel too
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshingSummary(false);
    }
  }

  // Auto-fetch new files on visit, once per page load - "if new files get
  // dropped into the folder, it should automatically fetch and show how
  // many new files were added" (direct feedback), instead of requiring a
  // manual "Scan folder now" click every time. Guarded by a ref (not
  // state) so it fires exactly once even though `topic` updates several
  // times as the page's other data loads in.
  useEffect(() => {
    if (topic && topic.folders.length > 0 && !autoScannedRef.current && !ingesting) {
      autoScannedRef.current = true;
      runBulkJob(api.ingest(id), setIngesting, setIngestResult);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic]);

  useEffect(() => {
    if (topic && topic.files.length === 0) setSourcesModalOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic === null]);

  // Client-side only, no backend call - a Markdown snapshot of what's
  // already loaded on this page (the PRD's own "save a Markdown version
  // locally" Should-have, which nothing in the app did until now).
  function handleExportBrief() {
    const lines = [`# ${topic.name}`, ""];
    if (topic.one_liner) lines.push(topic.one_liner, "");
    if (summary) {
      lines.push("## AI Context Brief", "");
      const fields = [
        ["Why now", summary.why_now],
        ["Current state", summary.current_state],
        ["History", summary.history],
        ["What the customer thinks", summary.customer_thoughts],
        ["Promises made", summary.promises_made],
        ["Next move", summary.next_step],
        ["Risks & gaps", summary.risks_and_gaps],
      ];
      fields.forEach(([label, value]) => value && lines.push(`**${label}:** ${value}`, ""));
    }
    const stakeholders = collectStakeholders(meetingMetadata, topic.related_people);
    if (stakeholders.length > 0) {
      lines.push("## Key Stakeholders", "", stakeholders.map((s) => `- ${s}`).join("\n"), "");
    }
    if (meetingMetadata.length > 0) {
      lines.push("## Meeting Info", "");
      meetingMetadata.forEach((m) => {
        const bits = [formatMeetingDate(m.meeting_date), m.meeting_time].filter(Boolean).join(" · ");
        lines.push(`- **${m.meeting_title || fileDisplayName(m)}** (${bits})`);
        if (m.attendees?.length) lines.push(`  Attendees: ${m.attendees.join(", ")}`);
        if (m.achieved) lines.push(`  Achieved: ${m.achieved}`);
      });
      lines.push("");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${topic.name.replace(/[^a-z0-9]+/gi, "_") || "project"}_brief.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Client-side stand-ins for the backend's export endpoints (see
  // lib/demoFiles.js) - built in the browser from the fixture data.
  function exportBaseName() {
    return topic.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "project";
  }

  function handleExportBriefOnly() {
    downloadText(`${exportBaseName()}-brief.md`, "text/markdown", briefMarkdown(topic, summary));
  }

  function handleExportSummaryCsv() {
    downloadText(`${exportBaseName()}-brief-fields.csv`, "text/csv", summaryCsv(summary));
  }

  function handleExportTasksCsv() {
    downloadText(`${exportBaseName()}-tasks.csv`, "text/csv", tasksCsv(tasks));
  }

  async function handleAddFolder(e) {
    e.preventDefault();
    if (!newFolder.trim()) return;
    setAddingFolder(true);
    try {
      await api.addFolder(id, newFolder.trim());
      setNewFolder("");
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setAddingFolder(false);
    }
  }

  // Shared by every bulk data-fetch action (scan, folder upload, mbox/ics
  // import): each backend action now starts a background ScanJob and
  // returns {job_id} immediately instead of blocking one request - this
  // polls scan_status until it's done, driving the same progress bar and
  // real-time refresh for all four instead of each reimplementing it.
  function runBulkJob(startPromise, setBusy, setResult) {
    setBusy(true);
    setResult(null);
    setScanJob(null);
    const poll = async () => {
      try {
        const job = await api.getScanStatus(id);
        setScanJob(job);
        if (job.status === "done" || job.status === "error") {
          setBusy(false);
          setResult({
            scanned: job.scanned,
            added: job.added,
            updated: job.updated,
            unchanged: job.unchanged,
            errors: job.error_message ? [job.error_message] : [],
          });
          if (job.added > 0) {
            setNewFilesBanner(`${job.added} new file${job.added === 1 ? "" : "s"} found and added.`);
          }
          load();
          refreshExtras();
          return;
        }
      } catch (e) {
        setError(e.message);
        setBusy(false);
        return;
      }
      setTimeout(poll, 1200);
    };
    startPromise.then(poll).catch((e) => {
      setError(e.message);
      setBusy(false);
    });
  }

  function handleIngest() {
    runBulkJob(api.ingest(id), setIngesting, setIngestResult);
  }

  const MEDIA_EXTENSIONS = [".mp4", ".mov", ".webm", ".wav", ".mp3", ".m4a"];

  async function handleFileUpload(file) {
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    // Audio/video goes through the background-job path (transcription can
    // take minutes) - same polling runBulkJob already does for folder scans.
    if (MEDIA_EXTENSIONS.includes(ext)) {
      runBulkJob(api.uploadFile(id, file), setUploading, () => {});
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      await api.uploadFile(id, file);
      load();
      refreshExtras();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleMboxPicked(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    runBulkJob(api.importMbox(id, file), setImportingMbox, setMboxResult);
    if (mboxInputRef.current) mboxInputRef.current.value = "";
  }

  function handleIcsPicked(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    runBulkJob(api.importIcs(id, file), setImportingIcs, setIcsResult);
    if (icsInputRef.current) icsInputRef.current.value = "";
  }

  function handleFolderPicked(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    runBulkJob(api.uploadFolder(id, files), setUploadingFolder, setFolderUploadResult);
    if (folderDirInputRef.current) folderDirInputRef.current.value = "";
  }

  async function handlePaste(e) {
    e.preventDefault();
    if (!pasteText.trim()) return;
    setPasting(true);
    try {
      await api.pasteText(id, pasteText.trim(), pasteLabel.trim());
      setPasteText("");
      setPasteLabel("");
      load();
      refreshExtras();
    } catch (e) {
      setError(e.message);
    } finally {
      setPasting(false);
    }
  }


  async function handleComputePayroll() {
    setComputingPayroll(true);
    try {
      const result = await api.computePayroll(id);
      setPayrollRuns((runs) => [
        { ...result, approved: false, approved_at: null, approving: false },
        ...runs,
      ]);
      loadWorkflowHistory(); // so it shows up on the timeline right away
    } catch (e) {
      setError(e.message);
    } finally {
      setComputingPayroll(false);
    }
  }

  async function handleApprovePayroll(workflowId) {
    setPayrollRuns((runs) =>
      runs.map((r) => (r.id === workflowId ? { ...r, approving: true } : r))
    );
    try {
      const result = await api.approvePayroll(id, workflowId);
      setPayrollRuns((runs) =>
        runs.map((r) =>
          r.id === workflowId
            ? {
                ...r,
                approving: false,
                approved: true,
                approved_at: (result && result.approved_at) || new Date().toISOString(),
              }
            : r
        )
      );
      loadWorkflowHistory(); // so the approval shows up on the timeline right away
    } catch (e) {
      setError(e.message);
      setPayrollRuns((runs) =>
        runs.map((r) => (r.id === workflowId ? { ...r, approving: false } : r))
      );
    }
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-10">
        <p className="text-red-600 text-sm">Error: {error}</p>
        <Link href="/dashboard" className="text-teal-dark text-sm underline">
          Back to projects
        </Link>
      </div>
    );
  }

  if (!topic) {
    return <div className="max-w-4xl mx-auto px-6 py-10 text-slate-400 text-sm">Loading...</div>;
  }

  const urgency = projectUrgency(tasks);
  const urgencyStyle = urgency ? URGENCY_STYLES[urgency] : null;

  return (
    <div className="w-full">
      {/* Full-width header - the global project actions sit at its right edge. */}
      <header className="sticky top-0 z-20 h-[4.5rem] bg-cream/95 backdrop-blur border-b border-border-warm px-6 flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2 flex-wrap">
          <Link href="/dashboard" className="text-sm text-teal-dark hover:underline shrink-0">
            ← All projects
          </Link>
          <h1 className="text-[22px] font-bold tracking-tight text-[#1a1a1a] truncate">{topic.name}</h1>
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${TYPE_STYLES[topic.topic_type] || "bg-slate-100 text-slate-700"}`}
          >
            {TYPE_LABELS[topic.topic_type] || topic.topic_type}
          </span>
          {urgencyStyle && (
            <span
              className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${urgencyStyle.bg} ${urgencyStyle.text} border ${urgencyStyle.border}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${urgencyStyle.dot}`} />
              {urgencyStyle.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setEditProjectOpen(true)}
            className="px-2.5 py-1.5 text-xs font-medium rounded-md text-slate-600 hover:bg-slate-100"
          >
            ✎ Edit Project
          </button>
          <button
            type="button"
            onClick={() => setCalendarModalOpen(true)}
            className="px-2.5 py-1.5 text-xs font-medium rounded-md text-slate-600 hover:bg-slate-100"
          >
            📅 Calendar
          </button>
          <button
            type="button"
            onClick={() => setSourcesModalOpen(true)}
            className="px-2.5 py-1.5 text-xs font-medium rounded-md text-slate-600 hover:bg-slate-100"
          >
            ⚙ Manage sources
          </button>
          <div className="relative" ref={dataMenuRef}>
            <button
              type="button"
              onClick={() => setDataMenuOpen((v) => !v)}
              className="px-2.5 py-1.5 text-xs font-medium rounded-md text-slate-600 hover:bg-slate-100"
              title="Export or import the brief and tasks using Markdown/CSV"
            >
              ⇅ Export / Import
            </button>
            {dataMenuOpen && (
              <div className="absolute right-0 mt-1 w-64 bg-white border border-border-warm rounded-lg shadow-lg py-1 z-30 text-sm">
                <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                  Brief
                </div>
                <button
                  type="button"
                  onClick={() => { handleExportBrief(); setDataMenuOpen(false); }}
                  className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                >
                  ↓ Full page snapshot (.md)
                </button>
                <button
                  type="button"
                  onClick={() => { handleExportBriefOnly(); setDataMenuOpen(false); }}
                  className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                  title="AI Context Brief fields only"
                >
                  ↓ AI brief only (.md)
                </button>
                <button
                  type="button"
                  onClick={() => { handleExportSummaryCsv(); setDataMenuOpen(false); }}
                  className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                >
                  ↓ AI brief fields (.csv)
                </button>
                <button
                  type="button"
                  onClick={() => { summaryCsvInputRef.current?.click(); setDataMenuOpen(false); }}
                  disabled={importingSummaryCsv}
                  className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {importingSummaryCsv ? "Importing…" : "↑ Import edited brief (.csv)"}
                </button>
                <div className="mt-1 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted border-t border-border-warm">
                  Tasks
                </div>
                <button
                  type="button"
                  onClick={() => { handleExportTasksCsv(); setDataMenuOpen(false); }}
                  className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                >
                  ↓ Tasks (.csv)
                </button>
                <button
                  type="button"
                  onClick={() => { tasksCsvInputRef.current?.click(); setDataMenuOpen(false); }}
                  disabled={importingTasksCsv}
                  className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {importingTasksCsv ? "Importing…" : "↑ Import edited tasks (.csv)"}
                </button>
              </div>
            )}
          </div>
          <input
            ref={tasksCsvInputRef}
            type="file"
            accept=".csv"
            onChange={handleImportTasksCsv}
            className="hidden"
          />
          <input
            ref={summaryCsvInputRef}
            type="file"
            accept=".csv"
            onChange={handleImportSummaryCsv}
            className="hidden"
          />
        </div>
      </header>

      {newFilesBanner && (
        <div className="bg-teal-50 border-b border-teal-100 px-6 py-2 flex items-center justify-between gap-4">
          <p className="text-sm text-teal-800">🔔 {newFilesBanner}</p>
          <button
            type="button"
            onClick={() => setNewFilesBanner(null)}
            className="text-teal-600 hover:text-teal-800 text-sm shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      <ProjectTabs tabs={PROJECT_TABS} activeKey={projectTab} onChange={selectProjectTab} />

      {topic.files.length === 0 && (
        <div className="max-w-5xl mx-auto px-6 pt-6">
          <div className="rounded-lg border-2 border-dashed border-amber-300 bg-amber-50 px-5 py-4">
            <p className="text-sm font-medium text-amber-900">
              No files added to this project yet &mdash; add some so OrientMe can actually answer
              questions about it.
            </p>
            <button
              type="button"
              onClick={() => setSourcesModalOpen(true)}
              className="text-sm font-medium text-amber-700 hover:underline mt-1"
            >
              ↓ Manage sources (Lookup folder, Upload file, Upload folder, or Paste text)
            </button>
          </div>
        </div>
      )}

      {/* Only one tab's content is ever mounted at a time - all topic data
          was already loaded once via refreshExtras() on page load, so
          switching tabs never re-fetches anything, it only changes what's
          rendered (no fixed side chat drawer anywhere in any tab - removed
          per direct product feedback: no fragmented chat surface inside
          OrientMe itself; asking questions stays a backend capability, not
          a UI here - see api.ask()). */}
      <div className="max-w-5xl mx-auto px-6 py-6">
        {projectTab === "overview" && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4 items-start">
            <div className="space-y-4 min-w-0">
              <AttentionCard tasks={tasks} commitments={commitments} limit={5} onViewAll={() => selectProjectTab("work")} />
              <ContextBriefPanel
                topic={topic}
                summary={summary}
                refreshing={refreshingSummary}
                onRefresh={handleRefreshSummary}
                hasFiles={topic.files.length > 0}
                files={topic.files}
                meetingMetadata={meetingMetadata}
                tasks={tasks}
                decisions={decisions}
                commitments={commitments}
                summaryHistory={summaryHistory}
                workflowHistory={workflowHistory}
                onOpenSources={() => setSourcesModalOpen(true)}
                projectState={projectState}
              />
            </div>
            <div className="lg:sticky lg:top-4 min-w-0">
              <ProjectTimeline
                topic={topic}
                meetingMetadata={meetingMetadata}
                tasks={tasks}
                summaryHistory={summaryHistory}
                workflowHistory={workflowHistory}
              />
            </div>
          </div>
        )}

        {projectTab === "work" && (
          <WorkTabPanel
            topicId={id}
            tasks={tasks}
            onChanged={loadTasks}
            topicType={topic.topic_type}
            payrollRuns={payrollRuns}
            computingPayroll={computingPayroll}
            onComputePayroll={handleComputePayroll}
            onApprovePayroll={handleApprovePayroll}
          />
        )}

        {projectTab === "commitments" && (
          <CommitmentsCard topicId={id} commitments={commitments} tasks={tasks} onChanged={loadCommitments} />
        )}

        {projectTab === "decisions" && (
          <DecisionsCard topicId={id} decisions={decisions} onChanged={loadDecisions} />
        )}

        {projectTab === "meetings" &&
          (meetingMetadata.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-[250px_1fr] gap-4 items-start">
              <StakeholdersCard meetingMetadata={meetingMetadata} relatedPeople={topic.related_people} />
              <section id="meeting-info" className="rounded-lg border border-slate-200 bg-white p-4 scroll-mt-4 min-w-0">
                <h2 className="text-sm font-semibold text-slate-700 mb-3">Meeting Info</h2>
                <div className="flex flex-wrap gap-3">
                  {meetingMetadata.map((m) => (
                    <div key={m.id} className="flex-1 min-w-[220px]">
                      <MeetingInfoCard entry={m} />
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <StakeholdersCard meetingMetadata={meetingMetadata} relatedPeople={topic.related_people} />
          ))}

        {projectTab === "risks" && (
          <RisksCard topicId={id} risks={risks} onChanged={loadRisks} aiRisksText={summary?.risks_and_gaps} />
        )}
      </div>

      {calendarModalOpen && (
        <CalendarModal onClose={() => setCalendarModalOpen(false)}>
          <CalendarWidget events={calendarEvents} />
        </CalendarModal>
      )}

      {editProjectOpen && (
        <EditProjectModal
          projectState={projectState}
          onClose={() => setEditProjectOpen(false)}
          onSave={handleSaveProjectState}
        />
      )}

      {/* "Manage sources" - the old "Add data" + "Ingested" sections - lives
          entirely in this popup now, off the main canvas, opened via the
          header button, the empty-state banner, or automatically for a
          brand-new topic with no files yet. */}
      {sourcesModalOpen && (
        <ManageSourcesModal onClose={() => setSourcesModalOpen(false)}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-0 md:divide-x md:divide-slate-100">
          <div className="overflow-hidden">
            <h2 className="text-sm font-semibold text-slate-700 px-4 pt-4">Add data</h2>
            <div className="flex flex-wrap border-b border-slate-100 mt-3 px-2">
              {FETCH_TABS.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                    activeTab === tab.key
                      ? "border-brand text-brand"
                      : "border-transparent text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="p-4">
              {activeTab === "folder" && (
                <div>
                  <p className="text-xs text-slate-500 mb-3">
                    Point at a local folder that already has (or will have) files in it — e.g. a
                    OneDrive project folder. Every time you scan, anything new or changed gets
                    picked up, and the date/time it was first added is captured as its reference
                    timestamp.
                  </p>
                  <ul className="space-y-1 mb-3">
                    {topic.folders.length === 0 && (
                      <li className="text-xs text-slate-400">No lookup folder added yet.</li>
                    )}
                    {topic.folders.map((f) => (
                      <li key={f.id} className="text-xs text-slate-600 break-all font-mono">
                        {f.path}
                      </li>
                    ))}
                  </ul>
                  <form onSubmit={handleAddFolder} className="space-y-2">
                    <input
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                      value={newFolder}
                      onChange={(e) => setNewFolder(e.target.value)}
                      placeholder="C:\Users\you\OneDrive\Project Folder"
                    />
                    <button
                      type="submit"
                      disabled={addingFolder}
                      className="w-full px-3 py-1.5 text-xs rounded-md bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      {addingFolder ? "Adding…" : "Add lookup folder"}
                    </button>
                  </form>
                  <button
                    onClick={handleIngest}
                    disabled={ingesting || topic.folders.length === 0}
                    className="w-full mt-2 px-3 py-1.5 text-xs rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
                  >
                    {ingesting ? "Scanning…" : "Scan folder now"}
                  </button>

                  <BulkJobProgress busy={ingesting} job={scanJob} />

                  {!ingesting && ingestResult && (
                    <p className="text-xs text-slate-500 mt-2">
                      Scanned {ingestResult.scanned} · {ingestResult.added} new · {ingestResult.updated}{" "}
                      updated · {ingestResult.unchanged} unchanged
                      {ingestResult.errors.length > 0 && (
                        <span className="block text-red-600 mt-1">
                          {ingestResult.errors.length} error(s).
                        </span>
                      )}
                    </p>
                  )}
                </div>
              )}

              {activeTab === "upload" && (
                <div>
                  <p className="text-xs text-slate-500 mb-3">
                    Add one file directly — no folder needed. Its added date/time is captured the
                    same way as a lookup folder file.
                  </p>
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverUpload(true);
                    }}
                    onDragLeave={() => setDragOverUpload(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverUpload(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file) handleFileUpload(file);
                    }}
                    onClick={() => !uploading && fileInputRef.current?.click()}
                    className={`rounded-lg border-2 border-dashed px-4 py-8 text-center cursor-pointer transition-colors ${
                      dragOverUpload
                        ? "border-teal bg-teal-tint"
                        : "border-slate-200 hover:border-teal hover:bg-teal-tint/40"
                    }`}
                  >
                    <UploadIcon />
                    <p className="text-xs font-medium text-slate-600 mt-2">
                      {uploading ? "Uploading…" : "Click or drag and drop to upload a file"}
                    </p>
                    <p className="text-[10px] text-slate-400 mt-1">
                      .txt, .md, .docx, .pdf, .xlsx, .pptx, .eml, .msg — or a meeting recording
                      (.mp4, .mov, .webm, .wav, .mp3, .m4a), transcribed locally on upload
                    </p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".txt,.md,.docx,.pdf,.xlsx,.xlsm,.pptx,.eml,.msg,.mp4,.mov,.webm,.wav,.mp3,.m4a"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileUpload(file);
                      }}
                      disabled={uploading}
                      className="hidden"
                    />
                  </div>

                  <BulkJobProgress busy={uploading} job={scanJob} />
                </div>
              )}

              {activeTab === "folderUpload" && (
                <div>
                  <p className="text-xs text-slate-500 mb-3">
                    Pick a whole folder from your computer in one go — every file inside it
                    uploads and ingests in a single action, no folder path to type or link to
                    copy/paste.
                  </p>
                  <input
                    ref={folderDirInputRef}
                    type="file"
                    webkitdirectory=""
                    directory=""
                    multiple
                    onChange={handleFolderPicked}
                    disabled={uploadingFolder}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => folderDirInputRef.current?.click()}
                    disabled={uploadingFolder}
                    className="w-full px-3 py-1.5 text-xs rounded-md bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {uploadingFolder ? "Uploading…" : "Choose folder to upload"}
                  </button>

                  <BulkJobProgress busy={uploadingFolder} job={scanJob} />

                  {!uploadingFolder && folderUploadResult && (
                    <p className="text-xs text-slate-500 mt-2">
                      Uploaded {folderUploadResult.updated}
                      {folderUploadResult.errors && folderUploadResult.errors.length > 0 && (
                        <span className="block text-red-600 mt-1">
                          {folderUploadResult.errors.length} error(s).
                        </span>
                      )}
                    </p>
                  )}
                </div>
              )}

              {activeTab === "paste" && (
                <form onSubmit={handlePaste} className="space-y-2">
                  <p className="text-xs text-slate-500 mb-1">
                    Paste an email body, a quick note, anything text-based — captured with its own
                    reference timestamp, same as a file.
                  </p>
                  <input
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                    value={pasteLabel}
                    onChange={(e) => setPasteLabel(e.target.value)}
                    placeholder="Label (optional) — e.g. Email from Rizwan, 10 Sep"
                  />
                  <textarea
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs resize-none"
                    rows={5}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    placeholder="Paste the text here…"
                  />
                  <button
                    type="submit"
                    disabled={pasting}
                    className="w-full px-3 py-1.5 text-xs rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
                  >
                    {pasting ? "Adding…" : "Add pasted text"}
                  </button>
                </form>
              )}

              {activeTab === "more" && (
                <div className="space-y-3">
                  <div className="rounded-md border border-slate-200 px-3 py-2.5">
                    <p className="text-xs font-medium text-slate-700">Email export (.mbox)</p>
                    <p className="text-xs text-slate-400 mt-0.5 mb-2">
                      One IngestedFile per message, each independently askable. .pst isn&apos;t
                      supported — it needs a real third-party parser, a separate piece of work.
                    </p>
                    <input
                      ref={mboxInputRef}
                      type="file"
                      accept=".mbox"
                      onChange={handleMboxPicked}
                      disabled={importingMbox}
                      className="w-full text-xs"
                    />
                    <BulkJobProgress busy={importingMbox} job={scanJob} />
                    {!importingMbox && mboxResult && (
                      <p className="text-xs text-emerald-700 mt-1">
                        Imported {mboxResult.updated} email{mboxResult.updated === 1 ? "" : "s"}.
                      </p>
                    )}
                  </div>

                  <div className="rounded-md border border-slate-200 px-3 py-2.5">
                    <p className="text-xs font-medium text-slate-700">Calendar export (.ics)</p>
                    <p className="text-xs text-slate-400 mt-0.5 mb-2">
                      Each event becomes a Meeting Info card directly — real title/date/attendees
                      from the file, not guessed.
                    </p>
                    <input
                      ref={icsInputRef}
                      type="file"
                      accept=".ics"
                      onChange={handleIcsPicked}
                      disabled={importingIcs}
                      className="w-full text-xs"
                    />
                    <BulkJobProgress busy={importingIcs} job={scanJob} />
                    {!importingIcs && icsResult && (
                      <p className="text-xs text-emerald-700 mt-1">
                        Imported {icsResult.updated} event{icsResult.updated === 1 ? "" : "s"}.
                      </p>
                    )}
                  </div>

                  <div className="rounded-md border border-dashed border-slate-200 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-xs font-medium text-slate-600">Meeting transcript folder</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Already covered — &ldquo;Lookup folder&rdquo; handles any folder of
                          transcripts.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setActiveTab("folder")}
                        className="text-[11px] font-medium text-teal-dark hover:underline shrink-0"
                      >
                        Use it →
                      </button>
                    </div>
                  </div>

                  <div className="rounded-md border border-dashed border-slate-200 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-600">SharePoint / Teams (live)</span>
                      <span className="text-[10px] uppercase tracking-wide text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                        Coming soon
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Needs an Entra ID app registration — a real decision, not just an
                      engineering task.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="overflow-hidden p-4">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">
              Ingested ({topic.files.length})
            </h2>
            <ul className="space-y-2 max-h-72 overflow-y-auto">
              {topic.files.length === 0 && (
                <li className="text-xs text-slate-400">Nothing ingested yet.</li>
              )}
              {topic.files.map((f) => (
                <li key={f.id} className="text-xs border-b border-slate-50 pb-2 last:border-0">
                  {f.extraction_error ? (
                    <span className="text-red-600">
                      ⚠ {(f.display_name || f.path).split(/[\\/]/).pop()} — {f.extraction_error}
                    </span>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-slate-700 truncate">
                          {(f.display_name || f.path).split(/[\\/]/).pop()}
                        </span>
                        <span className="text-[10px] uppercase tracking-wide text-slate-400 shrink-0">
                          {SOURCE_METHOD_LABELS[f.source_method] || f.source_method}
                        </span>
                      </div>
                      <span className="text-slate-400">Added {formatAdded(f.first_added_at)}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
        </ManageSourcesModal>
      )}
    </div>
  );
}

// Bullet-formatted field text ("- line one\n- line two") -> array of lines.
// Tolerant of a plain sentence too (no leading "- ") - it just renders as
// one line, never broken, if the model ever ignores the bullet instruction.
function toBullets(text) {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean);
}

// The "Context Node" one-screen primary view - follows the supplied UI
// prototype's low-friction capture pattern
// Products (1).md") - Current Objective / Where was I / Next-Waiting-Open
// Questions / Recent Activity / Key State / Launchers - replacing the
// earlier flat 7-section dump, which he called out as "becoming fixed"
// (24 Sep standup). Persisted (CaseSummary) so it doesn't need a fresh
// question typed in every time this page is opened.
// topic.messages alternates user/assistant, one pair per _ask_topic call -
// pairs each question with the answer that immediately followed it.
function buildPromptHistory(messages) {
  const msgs = messages || [];
  const pairs = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "user" && msgs[i + 1]?.role === "assistant") {
      pairs.push({
        id: msgs[i].id,
        question: msgs[i].content,
        answer: msgs[i + 1].content,
        date: msgs[i].created_at,
        answerId: msgs[i + 1].id,
        feedback: msgs[i + 1].feedback || "",
      });
    }
  }
  return pairs.reverse(); // newest first
}

function ContextBriefPanel({
  topic,
  summary,
  refreshing,
  onRefresh,
  hasFiles,
  files,
  meetingMetadata,
  tasks,
  decisions,
  commitments,
  summaryHistory,
  workflowHistory,
  onOpenSources,
  projectState,
}) {
  const byPath = Object.fromEntries((files || []).map((f) => [f.path, f]));
  const fieldSources = summary?.field_sources || {};
  const [promptHistoryOpen, setPromptHistoryOpen] = useState(false);
  const [expandedPromptId, setExpandedPromptId] = useState(null);
  const [feedbackOverrides, setFeedbackOverrides] = useState({});
  const promptHistory = buildPromptHistory(topic.messages).map((p) => ({
    ...p,
    feedback: feedbackOverrides[p.answerId] ?? p.feedback,
  }));

  async function handleFeedback(answerId, value) {
    setFeedbackOverrides((prev) => ({ ...prev, [answerId]: value }));
    try {
      await api.setMessageFeedback("topic", answerId, value);
    } catch {
      // Unobtrusive by design - a failed feedback click isn't worth
      // surfacing an error for; it just won't have persisted.
    }
  }

  function EditLinks({ paths }) {
    const matched = (paths || []).map((p) => byPath[p]).filter(Boolean);
    if (matched.length === 0) return null;
    return (
      <p className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
        {matched.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => openSourceFile(f)}
            title={`Open ${f.display_name || f.path} in its own application to edit it`}
            className="text-[11px] text-brand hover:underline whitespace-nowrap"
          >
            {(f.display_name || f.path).split(/[\\/]/).pop()} · Edit ↗
          </button>
        ))}
      </p>
    );
  }

  function BulletColumn({ icon, label, text, sourceKey }) {
    const bullets = toBullets(text);
    if (bullets.length === 0) return null;
    return (
      <div className="flex-1 min-w-[150px]">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
          {icon} {label}
        </p>
        <ul className="space-y-0.5">
          {bullets.map((b, i) => (
            <li key={i} className="text-sm text-slate-700 flex gap-1.5">
              <span className="text-slate-300 shrink-0">•</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
        {sourceKey && <EditLinks paths={fieldSources[sourceKey]} />}
      </div>
    );
  }

  // Compact Recent Activity - top 4, newest first. The full history lives
  // in Project Timeline further down this same page (#project-timeline).
  const recentEvents = summary
    ? [...buildTimelineEvents(topic, meetingMetadata, tasks, summaryHistory, workflowHistory)]
        .reverse()
        .slice(0, 4)
    : [];

  const stakeholderNames = collectStakeholders(meetingMetadata, topic.related_people);
  const firstFolder = topic.folders?.[0];

  // Meetings/Documents/Full history dropped from here - all three are
  // already visible further down this same page. In this static demo the
  // two backend-backed launchers are simulated client-side: index.html opens
  // a page generated in the browser from the brief, and Project folder
  // explains that opening a local folder needs the full app.
  const launchers = [
    { icon: "✅", label: "Tasks", href: "/tasks" },
    { icon: "🌐", label: "index.html", onClick: () => openInNewTab(briefHtmlPage(topic, summary)) },
    firstFolder && {
      icon: "📁",
      label: "Project folder",
      onClick: () =>
        window.alert(
          `Demo mode - the full app opens ${firstFolder.path} in File Explorer. A static web page can't open folders on your computer.`
        ),
    },
  ].filter(Boolean);

  return (
    <section className="rounded-xl border border-border-warm border-l-4 border-l-brand bg-white shadow-sm p-4 min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-[15px] font-bold text-brand">Context Node</h2>
        <div className="flex items-center gap-3 shrink-0">
          {summary?.generated_at && (
            <span className="text-[11px] text-ink-muted">Updated {formatTimeAgo(summary.generated_at)}</span>
          )}
          <button
            type="button"
            onClick={() => onRefresh()}
            disabled={refreshing || !hasFiles}
            title={hasFiles ? "Regenerate from the latest ingested files" : "Add files first"}
            className="text-xs font-medium text-brand hover:underline disabled:opacity-40 disabled:no-underline"
          >
            {refreshing ? "Refreshing…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      {/* Smart Suggestions - one-click preset questions that regenerate
          this same panel via the existing refresh mechanism, never a chat
          input (see the standing product decision noted further down this
          file where the reading column begins). */}
      {hasFiles && (
        <div className="flex flex-wrap gap-1.5 mb-3 scroll-mt-6">
          {SMART_SUGGESTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => onRefresh(s.question)}
              disabled={refreshing}
              className="text-[11px] px-2 py-1 rounded-full border border-brand/20 bg-white text-brand hover:bg-brand/5 disabled:opacity-40"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* Explicit Project Intelligence - a person's own stated current
          position, distinct from (and higher-priority to the LLM than) the
          AI-regenerated brief below. Always visible, even before any brief
          has been generated. */}
      <div className="mb-3 pb-3 border-b border-brand/10">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
          📝 Current Position (confirmed)
        </p>
        {(projectState?.current_position || "").trim() ? (
          <>
            <p className="text-sm text-slate-800 whitespace-pre-wrap">{projectState.current_position}</p>
            <p className="text-[11px] text-slate-400 mt-1">
              Updated by {projectState.updated_by || "someone"}
              {projectState.updated_at ? ` · ${formatTimeAgo(projectState.updated_at)}` : ""}
            </p>
          </>
        ) : (
          <p className="text-xs text-slate-500">
            Not set yet — use &ldquo;✎ Edit Project&rdquo; above to state where things actually
            stand, so OrientMe treats it as ground truth without editing any source document.
          </p>
        )}
      </div>

      {!summary && (
        <p className="text-xs text-slate-500">
          {hasFiles
            ? 'No brief generated yet — click "Refresh", or just ask a question via search.'
            : "Add some files, then generate a brief — this is where your current state and next move will show up automatically."}
        </p>
      )}

      {summary && (
        <div className="space-y-4">
          {/* Executive Summary is a genuine short project description
              (topic.one_liner), NOT the answer to whatever was just asked -
              real feedback: "when i am giving the prompt the answer is
              comming under executive summary... this should come under no
              heading. executive summary should just give me the project
              summary in short." */}
          {(topic.one_liner || "").trim() && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-brand mb-0.5">
                Executive Summary
              </p>
              <p className="text-sm text-slate-800">{topic.one_liner}</p>
            </div>
          )}

          {/* The direct answer to the actual question asked - no heading,
              per that same feedback. */}
          {(summary.answer_summary || "").trim() && (
            <p className="text-sm text-slate-800">{summary.answer_summary}</p>
          )}

          {(summary.why_now || "").trim() && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-0.5">
                🎯 Current objective
              </p>
              <p className="text-sm text-slate-800 font-medium">{summary.why_now}</p>
            </div>
          )}

          {toBullets(summary.current_state).length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
                ▶ Current Position
              </p>
              <ul className="space-y-0.5">
                {toBullets(summary.current_state).map((b, i) => (
                  <li key={i} className="text-sm text-slate-700 flex gap-1.5">
                    <span className="text-slate-300 shrink-0">•</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
              <EditLinks paths={fieldSources.current_state} />
            </div>
          )}

          {/* Dynamic, question-specific sections - only render the ones the
              LLM actually filled in for this particular answer (per prompt
              rule in llm_brief.py: each of these fires only for a specific
              kind of question, e.g. meeting_prep only for "help me prepare
              for..."). Never a fixed template - "make it dynamic... if open
              questions not required dont add." */}
          {DYNAMIC_SECTION_FIELDS.map(
            ({ key, icon, label }) =>
              toBullets(summary[key]).length > 0 && (
                <div key={key} className="border-t border-brand/10 pt-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
                    {icon} {label}
                  </p>
                  <ul className="space-y-0.5">
                    {toBullets(summary[key]).map((b, i) => (
                      <li key={i} className="text-sm text-slate-700 flex gap-1.5">
                        <span className="text-slate-300 shrink-0">•</span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                  <EditLinks paths={fieldSources[key]} />
                </div>
              )
          )}

          <div className="flex flex-wrap gap-4 border-t border-brand/10 pt-3">
            <BulletColumn icon="➜" label="Next" text={summary.next_step} sourceKey="next_step" />
            <BulletColumn icon="⏳" label="Waiting" text={summary.promises_made} sourceKey="promises_made" />
            <BulletColumn icon="❓" label="Open questions" text={summary.risks_and_gaps} sourceKey="risks_and_gaps" />
          </div>

          {recentEvents.length > 0 && (
            <div className="border-t border-brand/10 pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
                🕘 Recent activity
              </p>
              <ul className="space-y-1">
                {recentEvents.map((e) => (
                  <li key={e.key} className="text-sm text-slate-700 flex gap-2">
                    <span className="text-slate-400 w-14 shrink-0">{formatRelativeDay(e.sortTs)}</span>
                    <span>{e.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Decisions/Commitments/Facts aren't tracked as their own fields
              yet (see PROJECT-CONTEXT / the 24 Sep mockup) - shown honestly
              as not-yet-tracked rather than faked, while People/Risks/
              Important links reuse data that's already real. */}
          <div className="border-t border-brand/10 pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1">
              📌 Key state
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>
                Decisions <span className="font-medium text-slate-700">{(decisions || []).length}</span>
              </span>
              <span>
                Commitments <span className="font-medium text-slate-700">{(commitments || []).length}</span>
              </span>
              <span>
                People <span className="font-medium text-slate-700">{stakeholderNames.length}</span>
              </span>
              <span>
                Facts <span className="text-slate-300">— not yet tracked</span>
              </span>
              <span>
                Risks <span className="font-medium text-slate-700">{toBullets(summary.risks_and_gaps).length}</span>
              </span>
              <span>
                Important links{" "}
                <span className="font-medium text-slate-700">{(summary.sources_used || []).length}</span>
              </span>
            </div>
          </div>

          <div className="border-t border-brand/10 pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">Launchers</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setPromptHistoryOpen((v) => !v)}
                disabled={promptHistory.length === 0}
                title={promptHistory.length === 0 ? "No questions asked yet" : "Show past questions and answers"}
                className="text-xs px-2.5 py-1 rounded-full border border-slate-200 bg-white text-slate-600 hover:border-brand hover:text-brand transition-colors disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:text-slate-600"
              >
                🤖 AI conversations{promptHistory.length > 0 ? ` (${promptHistory.length})` : ""}
              </button>
              {launchers.map((l) =>
                l.onClick ? (
                  <button
                    key={l.label}
                    type="button"
                    onClick={l.onClick}
                    className="text-xs px-2.5 py-1 rounded-full border border-slate-200 bg-white text-slate-600 hover:border-brand hover:text-brand transition-colors"
                  >
                    {l.icon} {l.label}
                  </button>
                ) : (
                  <a
                    key={l.label}
                    href={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}${l.href}`}
                    target={l.external ? "_blank" : undefined}
                    rel={l.external ? "noreferrer" : undefined}
                    className="text-xs px-2.5 py-1 rounded-full border border-slate-200 bg-white text-slate-600 hover:border-brand hover:text-brand transition-colors"
                  >
                    {l.icon} {l.label}
                  </a>
                )
              )}
            </div>
          </div>

          {/* Prompt history - "click a past question, see its answer" - the
              questions/answers already exist as ChatMessage rows (topic.
              messages); this just surfaces them instead of only ever
              showing the latest brief. */}
          {promptHistoryOpen && (
            <div className="border-t border-brand/10 pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                Prompt history
              </p>
              {promptHistory.length === 0 ? (
                <p className="text-xs text-slate-400">No questions asked yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {promptHistory.map((p) => {
                    const expanded = expandedPromptId === p.id;
                    return (
                      <li key={p.id} className="rounded-md border border-slate-100">
                        <button
                          type="button"
                          onClick={() => setExpandedPromptId(expanded ? null : p.id)}
                          className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-slate-50 transition-colors"
                        >
                          <span className="text-sm text-slate-700 truncate">{p.question}</span>
                          <span className="text-[11px] text-slate-400 shrink-0">
                            {formatAdded(p.date)} {expanded ? "▲" : "▼"}
                          </span>
                        </button>
                        {expanded && (
                          <div className="px-2.5 pb-2">
                            <p className="text-sm text-slate-600 whitespace-pre-wrap">{p.answer}</p>
                            <div className="flex items-center gap-1 mt-1.5">
                              <span className="text-[10px] text-slate-400 mr-0.5">Helpful?</span>
                              <button
                                type="button"
                                title="Helpful"
                                onClick={() => handleFeedback(p.answerId, p.feedback === "up" ? "" : "up")}
                                className={`text-xs rounded px-1.5 py-0.5 ${
                                  p.feedback === "up" ? "bg-emerald-100 text-emerald-700" : "text-slate-300 hover:bg-slate-100"
                                }`}
                              >
                                👍
                              </button>
                              <button
                                type="button"
                                title="Not helpful"
                                onClick={() => handleFeedback(p.answerId, p.feedback === "down" ? "" : "down")}
                                className={`text-xs rounded px-1.5 py-0.5 ${
                                  p.feedback === "down" ? "bg-red-100 text-red-700" : "text-slate-300 hover:bg-slate-100"
                                }`}
                              >
                                👎
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          <p className="text-[11px] text-slate-400">Generated {formatAdded(summary.generated_at)}</p>
        </div>
      )}
    </section>
  );
}

// "What needs my attention" - calm and minimal, not a notification feed.
// Computed client-side from Task.due_date (see lib/format.taskUrgency) -
// no new backend data needed. Renders nothing at all when there's genuinely
// nothing to flag, matching this page's existing "don't show empty
// sections" convention.
// Trimmed to the top few items (spec: "do not flood this section with
// ordinary tasks") with a "View all →" out to the Action Items tab, where every
// task/commitment is visible in full. Overdue commitments rank above
// overdue tasks (a person's broken promise is a higher signal than a
// slipping task), matching the spec's own attention-priority ordering.
function AttentionCard({ tasks, commitments, limit = 5, onViewAll }) {
  const items = [
    ...(commitments || []).map((c) => ({
      id: `c-${c.id}`,
      label: `${c.person}: ${c.commitment}`,
      due_date: c.due_date,
      urgency: taskUrgency(c),
      type: "commitment",
    })),
    ...(tasks || []).map((t) => ({
      id: `t-${t.id}`,
      label: t.title,
      due_date: t.due_date,
      urgency: taskUrgency(t),
      type: "task",
    })),
  ].filter((i) => i.urgency === "red" || i.urgency === "yellow");

  if (items.length === 0) return null;

  items.sort((a, b) => {
    const rank = (i) => (i.urgency === "red" ? 0 : 2) + (i.type === "commitment" ? 0 : 1);
    return rank(a) - rank(b);
  });

  const shown = items.slice(0, limit);
  const hiddenCount = items.length - shown.length;

  return (
    <section className="rounded-xl border border-border-warm border-l-4 border-l-accent-orange bg-white shadow-sm p-4 min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-[15px] font-bold text-[#1a1a1a]">⚠ What needs your attention</h2>
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="text-xs font-medium text-amber-700 hover:underline shrink-0"
          >
            View all →
          </button>
        )}
      </div>
      <ul className="space-y-1">
        {shown.map((i) => (
          <li key={i.id} className={`text-sm flex gap-1.5 ${i.urgency === "red" ? "text-red-700" : "text-amber-800"}`}>
            <span className="shrink-0">●</span>
            <span>
              {i.label}{" "}
              <span className={i.urgency === "red" ? "text-red-500" : "text-amber-600"}>
                — {i.urgency === "red" ? "overdue" : "due soon"}
                {i.due_date ? ` (${i.due_date})` : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && <p className="text-[11px] text-amber-700 mt-1.5">+{hiddenCount} more</p>}
    </section>
  );
}

const COMMITMENT_STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
];

// A person's explicit promise/obligation - deliberately backed by its own
// Commitment model (see models.Commitment), NOT Task. "A teammate will
// provide the architecture proposal by Friday" is a commitment; "Create
// the architecture proposal" is the task it might produce - the two are
// independent records, optionally linked via linked_task. `tasks` here is
// only for populating the optional "link to task" picker.
function CommitmentsCard({ topicId, commitments, tasks, onChanged }) {
  const [adding, setAdding] = useState(false);
  const [person, setPerson] = useState("");
  const [commitmentText, setCommitmentText] = useState("");
  const [dateMade, setDateMade] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [linkedTask, setLinkedTask] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd(e) {
    e.preventDefault();
    if (!person.trim() || !commitmentText.trim()) return;
    setSaving(true);
    try {
      await api.createCommitment(topicId, {
        person: person.trim(),
        commitment: commitmentText.trim(),
        date_made: dateMade || null,
        due_date: dueDate || null,
        linked_task: linkedTask || null,
      });
      setPerson("");
      setCommitmentText("");
      setDateMade("");
      setDueDate("");
      setLinkedTask("");
      setAdding(false);
      onChanged();
    } catch (e) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleFieldChange(commitmentId, fields) {
    try {
      await api.updateCommitment(commitmentId, fields);
      onChanged();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <section className="rounded-lg border border-border-warm border-t-2 border-t-teal-dark bg-white shadow-sm p-4 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[15px] font-bold text-teal-dark">✅ Commitments</h2>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="text-xs font-medium text-brand hover:underline"
        >
          {adding ? "Cancel" : "+ Add"}
        </button>
      </div>
      {adding && (
        <form onSubmit={handleAdd} className="mb-3 space-y-1.5 rounded-md bg-slate-50 border border-slate-100 p-2.5">
          <div className="flex gap-1.5">
            <input
              type="text"
              placeholder="Person"
              value={person}
              onChange={(e) => setPerson(e.target.value)}
              className="w-32 shrink-0 text-xs border border-slate-200 rounded px-2 py-1"
              autoFocus
            />
            <input
              type="text"
              placeholder="What did they commit to?"
              value={commitmentText}
              onChange={(e) => setCommitmentText(e.target.value)}
              className="flex-1 min-w-0 text-xs border border-slate-200 rounded px-2 py-1"
            />
          </div>
          <div className="flex gap-1.5">
            <label className="flex-1 text-[10px] text-slate-400">
              Date made
              <input
                type="date"
                value={dateMade}
                onChange={(e) => setDateMade(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded px-2 py-1 mt-0.5"
              />
            </label>
            <label className="flex-1 text-[10px] text-slate-400">
              Due date
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded px-2 py-1 mt-0.5"
              />
            </label>
          </div>
          {(tasks || []).length > 0 && (
            <label className="block text-[10px] text-slate-400">
              Link to task (optional)
              <select
                value={linkedTask}
                onChange={(e) => setLinkedTask(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded px-2 py-1 mt-0.5"
              >
                <option value="">— none —</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="submit"
            disabled={saving || !person.trim() || !commitmentText.trim()}
            className="text-xs font-medium text-white bg-brand rounded px-2.5 py-1 disabled:opacity-40"
          >
            {saving ? "Adding…" : "Add commitment"}
          </button>
        </form>
      )}
      {(commitments || []).length === 0 ? (
        <p className="text-xs text-slate-400">
          No commitments logged yet — add one directly, or they&apos;ll be created here once
          meeting extraction supports them.
        </p>
      ) : (
        <ul className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
          {commitments.map((c) => {
            const urgency = taskUrgency(c);
            const style = urgency ? URGENCY_STYLES[urgency] : null;
            return (
              <li key={c.id} className="rounded-md border border-slate-100 bg-slate-50/50 px-2.5 py-2 text-xs">
                <div className="flex items-start gap-1.5">
                  {style && (
                    <span title={style.label} className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
                  )}
                  <p className="text-slate-800 font-medium flex-1 min-w-0 break-words">{c.commitment}</p>
                </div>
                <div className="flex items-center justify-between mt-1.5 gap-2 flex-wrap">
                  <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-full truncate max-w-[45%]">
                    {c.person}
                  </span>
                  <input
                    type="date"
                    value={c.due_date || ""}
                    onChange={(e) => handleFieldChange(c.id, { due_date: e.target.value || null })}
                    className={`text-[10px] border border-slate-200 rounded px-1 py-0.5 bg-white ${
                      style ? style.text : "text-slate-500"
                    }`}
                  />
                </div>
                {c.linked_task_title && (
                  <span className="inline-block mt-1.5 text-[10px] text-teal-dark bg-teal-tint border border-teal-tint-strong px-1.5 py-0.5 rounded-full">
                    🔗 {c.linked_task_title}
                  </span>
                )}
                <select
                  value={c.status}
                  onChange={(e) => handleFieldChange(c.id, { status: e.target.value })}
                  className="w-full mt-1.5 text-[10px] border border-slate-200 rounded px-1 py-0.5 bg-white"
                >
                  {COMMITMENT_STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// Decisions - genuinely new, structured, persistent data (see
// models.Decision) - distinct from CaseSummary.decisions_made, which is
// disposable free text regenerated fresh every brief.
function DecisionsCard({ topicId, decisions, onChanged }) {
  const [adding, setAdding] = useState(false);
  const [decisionText, setDecisionText] = useState("");
  const [context, setContext] = useState("");
  const [participants, setParticipants] = useState("");
  const [decidedDate, setDecidedDate] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd(e) {
    e.preventDefault();
    if (!decisionText.trim()) return;
    setSaving(true);
    try {
      await api.createDecision(topicId, {
        decision: decisionText.trim(),
        context: context.trim(),
        participants: participants.trim(),
        decided_date: decidedDate || null,
      });
      setDecisionText("");
      setContext("");
      setParticipants("");
      setDecidedDate("");
      setAdding(false);
      onChanged();
    } catch (e) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(d) {
    try {
      await api.updateDecision(d.id, { status: d.status === "decided" ? "reversed" : "decided" });
      onChanged();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <section className="rounded-lg border border-border-warm border-t-2 border-t-brand bg-white shadow-sm p-4 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[15px] font-bold text-brand">📋 Decisions</h2>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="text-xs font-medium text-brand hover:underline"
        >
          {adding ? "Cancel" : "+ Add"}
        </button>
      </div>
      {adding && (
        <form onSubmit={handleAdd} className="mb-3 space-y-1.5 rounded-md bg-slate-50 border border-slate-100 p-2.5">
          <input
            type="text"
            placeholder="What was decided?"
            value={decisionText}
            onChange={(e) => setDecisionText(e.target.value)}
            className="w-full text-xs border border-slate-200 rounded px-2 py-1"
            autoFocus
          />
          <input
            type="text"
            placeholder="Context / why (optional)"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className="w-full text-xs border border-slate-200 rounded px-2 py-1"
          />
          <div className="flex gap-1.5">
            <input
              type="text"
              placeholder="Participants"
              value={participants}
              onChange={(e) => setParticipants(e.target.value)}
              className="flex-1 text-xs border border-slate-200 rounded px-2 py-1"
            />
            <input
              type="date"
              value={decidedDate}
              onChange={(e) => setDecidedDate(e.target.value)}
              className="text-xs border border-slate-200 rounded px-2 py-1"
            />
          </div>
          <button
            type="submit"
            disabled={saving || !decisionText.trim()}
            className="text-xs font-medium text-white bg-brand rounded px-2.5 py-1 disabled:opacity-40"
          >
            {saving ? "Adding…" : "Add decision"}
          </button>
        </form>
      )}
      {(decisions || []).length === 0 ? (
        <p className="text-xs text-slate-400">No decisions logged yet.</p>
      ) : (
        <ul className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
          {decisions.map((d) => (
            <li key={d.id} className="border-b border-slate-50 pb-2 last:border-0">
              <div className="flex items-start justify-between gap-2">
                <p
                  className={`text-sm flex-1 min-w-0 ${
                    d.status === "reversed" ? "line-through text-slate-400" : "text-slate-800"
                  }`}
                >
                  {d.decision}
                </p>
                <button
                  type="button"
                  onClick={() => toggleStatus(d)}
                  title={d.status === "decided" ? "Mark as reversed" : "Mark as decided"}
                  className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border border-slate-200 text-slate-500 hover:border-brand hover:text-brand"
                >
                  {d.status === "decided" ? "Decided" : "Reversed"}
                </button>
              </div>
              {d.context && <p className="text-xs text-slate-500 mt-0.5">{d.context}</p>}
              {(d.participants || d.decided_date) && (
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {[d.participants, d.decided_date].filter(Boolean).join(" · ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const RISK_STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "mitigated", label: "Mitigated" },
  { value: "closed", label: "Closed" },
];

// Structured, tracked risks/blockers (see models.Risk) - distinct from the
// AI's own free-text risks_and_gaps, which is shown underneath, clearly
// labeled, preserving the Source vs. Current-State distinction rather than
// merging the two into one list.
function RisksCard({ topicId, risks, onChanged, aiRisksText }) {
  const [adding, setAdding] = useState(false);
  const [description, setDescription] = useState("");
  const [impact, setImpact] = useState("");
  const [owner, setOwner] = useState("");
  const [saving, setSaving] = useState(false);
  const aiBullets = toBullets(aiRisksText);

  async function handleAdd(e) {
    e.preventDefault();
    if (!description.trim()) return;
    setSaving(true);
    try {
      await api.createRisk(topicId, { description: description.trim(), impact: impact.trim(), owner: owner.trim() });
      setDescription("");
      setImpact("");
      setOwner("");
      setAdding(false);
      onChanged();
    } catch (e) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(riskId, status) {
    try {
      await api.updateRisk(riskId, { status });
      onChanged();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border-warm border-t-2 border-t-accent-orange bg-white shadow-sm p-4 min-w-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[15px] font-bold text-accent-orange">⚠ Risks</h2>
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="text-xs font-medium text-brand hover:underline"
          >
            {adding ? "Cancel" : "+ Add"}
          </button>
        </div>
        {adding && (
          <form onSubmit={handleAdd} className="mb-3 space-y-1.5 rounded-md bg-slate-50 border border-slate-100 p-2.5">
            <input
              type="text"
              placeholder="What could prevent this project from succeeding?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded px-2 py-1"
              autoFocus
            />
            <input
              type="text"
              placeholder="Impact (optional)"
              value={impact}
              onChange={(e) => setImpact(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded px-2 py-1"
            />
            <input
              type="text"
              placeholder="Owner (optional)"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded px-2 py-1"
            />
            <button
              type="submit"
              disabled={saving || !description.trim()}
              className="text-xs font-medium text-white bg-brand rounded px-2.5 py-1 disabled:opacity-40"
            >
              {saving ? "Adding…" : "Add risk"}
            </button>
          </form>
        )}
        {(risks || []).length === 0 ? (
          <p className="text-xs text-slate-400">No tracked risks yet.</p>
        ) : (
          <ul className="space-y-2">
            {risks.map((r) => (
              <li key={r.id} className="border-b border-slate-50 pb-2 last:border-0">
                <div className="flex items-start justify-between gap-2">
                  <p
                    className={`text-sm flex-1 min-w-0 ${
                      r.status === "closed" ? "line-through text-slate-400" : "text-slate-800"
                    }`}
                  >
                    {r.description}
                  </p>
                  <select
                    value={r.status}
                    onChange={(e) => handleStatusChange(r.id, e.target.value)}
                    className="shrink-0 text-[10px] border border-slate-200 rounded px-1 py-0.5 bg-white"
                  >
                    {RISK_STATUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                {r.impact && <p className="text-xs text-slate-500 mt-0.5">{r.impact}</p>}
                {r.owner && <p className="text-[11px] text-slate-400 mt-0.5">Owner: {r.owner}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {aiBullets.length > 0 && (
        <section className="rounded-lg border border-slate-200 bg-slate-50/60 p-4 min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
            AI&apos;s own read (from latest brief)
          </p>
          <ul className="space-y-0.5">
            {aiBullets.map((b, i) => (
              <li key={i} className="text-sm text-slate-600 flex gap-1.5">
                <span className="text-slate-300 shrink-0">•</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// Action Items tab (renamed from "Work") - the topic-scoped view onto the same Kanban board as the global
// /tasks page (TaskBoard.js is already topic-agnostic; this just filters to
// one topic's tasks, exactly the reuse the spec asked for instead of a
// second task-management surface). A small inline "+ Add task" form plus
// the existing PayrollWorkflowPanel (moved here, not rewritten) for process
// topics round out this tab.
function WorkTabPanel({ topicId, tasks, onChanged, topicType, payrollRuns, computingPayroll, onComputePayroll, onApprovePayroll }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleAdd(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      await api.createTask(topicId, { title: title.trim(), assignee: assignee.trim() });
      setTitle("");
      setAssignee("");
      setAdding(false);
      onChanged();
    } catch (e) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(taskId, status) {
    try {
      await api.updateTask(taskId, { status });
      onChanged();
    } catch (e) {
      alert(e.message);
    }
  }

  async function handleDueDateChange(taskId, dueDate) {
    try {
      await api.updateTask(taskId, { due_date: dueDate || null });
      onChanged();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-200 bg-white p-4 min-w-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-700">✅ Action Items</h2>
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="text-xs font-medium text-brand hover:underline"
          >
            {adding ? "Cancel" : "+ Add task"}
          </button>
        </div>
        {adding && (
          <form onSubmit={handleAdd} className="mb-3 flex gap-1.5 rounded-md bg-slate-50 border border-slate-100 p-2.5">
            <input
              type="text"
              placeholder="What needs to be done?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="flex-1 min-w-0 text-xs border border-slate-200 rounded px-2 py-1"
              autoFocus
            />
            <input
              type="text"
              placeholder="Assignee"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="w-32 shrink-0 text-xs border border-slate-200 rounded px-2 py-1"
            />
            <button
              type="submit"
              disabled={saving || !title.trim()}
              className="shrink-0 text-xs font-medium text-white bg-brand rounded px-2.5 py-1 disabled:opacity-40"
            >
              {saving ? "Adding…" : "Add"}
            </button>
          </form>
        )}
        <TaskBoard
          tasks={tasks}
          onStatusChange={handleStatusChange}
          onDueDateChange={handleDueDateChange}
          emptyMessage="No tasks yet — they're pulled automatically from meeting transcripts, or add one directly."
        />
      </section>

      {topicType === "process" && (
        <PayrollWorkflowPanel
          runs={payrollRuns}
          computing={computingPayroll}
          onCompute={onComputePayroll}
          onApprove={onApprovePayroll}
        />
      )}
    </div>
  );
}

// Sources - a plain browse list of every ingested file (already loaded on
// this page); the actual add/upload actions stay in the existing
// ManageSourcesModal, opened from here, matching the spec's own "Drawer/
// modal → editing" guidance instead of duplicating that UI in the tab.
// Explicit "Project Intelligence" editing - same overlay/close-button shell
// as CalendarModal/ManageSourcesModal further down this file, not a new
// pattern.
function EditProjectModal({ projectState, onClose, onSave }) {
  const [value, setValue] = useState(projectState?.current_position || "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(value);
      onClose();
    } catch (e) {
      alert(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 pt-4">
          <h2 className="text-sm font-semibold text-slate-800">Edit Project — Current Position</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">
            ×
          </button>
        </div>
        <div className="p-4">
          <p className="text-xs text-slate-500 mb-2">
            State where things actually stand, in your own words. OrientMe treats this as ground
            truth over the source documents — the source files themselves are never changed.
          </p>
          {(projectState?.previous_position || "").trim() && (
            <details className="mb-2 text-xs text-slate-500">
              <summary className="cursor-pointer hover:text-slate-700">Previous value</summary>
              <p className="mt-1 whitespace-pre-wrap">{projectState.previous_position}</p>
            </details>
          )}
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={6}
            className="w-full text-sm border border-slate-200 rounded-md px-3 py-2"
            autoFocus
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-4 pb-4">
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-medium text-slate-500 hover:text-slate-700 px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="text-xs font-medium text-white bg-brand rounded-md px-3 py-1.5 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Key stakeholders - the union of every meeting's real attendees (from
// ExtractedMeta, already computed) plus the topic's own free-text
// related_people field, deduped. No new backend call needed - both pieces
// are already loaded on this page.
function StakeholdersCard({ meetingMetadata, relatedPeople }) {
  const names = collectStakeholders(meetingMetadata, relatedPeople);

  if (names.length === 0) return null;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 min-w-0">
      <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
        👥 Key Stakeholders
      </h2>
      <div className="flex flex-col gap-2">
        {names.map((n) => {
          const { color, initials } = avatarStyle(n);
          return (
            <div
              key={n}
              className="flex items-center gap-2.5 rounded-lg border border-slate-100 bg-slate-50/60 px-2.5 py-2"
            >
              <span
                className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                style={{ background: color }}
              >
                {initials}
              </span>
              <span className="text-sm font-medium text-slate-800 truncate">{n}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// The calendar used to sit permanently in the canvas; it's a popup now too,
// reached from the header's Calendar button - CalendarWidget already has
// its own month-label/prev-next header, so this shell only adds the close
// control, not a second title.
function CalendarModal({ onClose, children }) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div className="relative w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          className="absolute -top-3 -right-3 w-7 h-7 rounded-full bg-white shadow-md border border-slate-200 text-slate-500 hover:text-slate-700 flex items-center justify-center text-lg leading-none z-10"
        >
          ×
        </button>
        {children}
      </div>
    </div>
  );
}

// The old "Add data" + "Ingested" sections, now a popup rather than a
// permanent block on the canvas - same overlay pattern as the Action
// Center's AiExecuteModal (backdrop click closes, a close button, a
// scrollable body), just sized wider for a two-column layout.
function ManageSourcesModal({ onClose, children }) {
  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pt-4 sticky top-0 bg-white">
          <h2 className="text-sm font-semibold text-slate-800">Manage sources</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 text-lg leading-none"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function MeetingInfoCard({ entry }) {
  const name = fileDisplayName(entry);
  const dateLabel = formatMeetingDate(entry.meeting_date);
  const chip = [dateLabel, entry.meeting_time].filter(Boolean).join(" · ");
  const attendees = Array.isArray(entry.attendees) ? entry.attendees : [];

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="font-semibold text-slate-900 text-sm">{entry.meeting_title || name}</h3>
      {chip && (
        <span className="inline-block text-[11px] font-medium text-teal-dark bg-teal-tint border border-teal-tint-strong px-2 py-0.5 rounded-full mt-1.5 mb-2">
          {chip}
        </span>
      )}
      {attendees.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2 mb-2">
          {attendees.map((a, i) => (
            <span
              key={i}
              className="text-[11px] text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full"
            >
              {a}
            </span>
          ))}
        </div>
      )}
      {entry.agenda && (
        <p className="text-xs text-slate-600 mt-1.5">
          <span className="font-medium text-slate-500">Target: </span>
          {entry.agenda}
        </p>
      )}
      {entry.achieved && (
        <p className="text-xs text-slate-600 mt-1">
          <span className="font-medium text-slate-500">Achieved: </span>
          {entry.achieved}
        </p>
      )}
      {entry.meeting_title && (
        <p className="text-[11px] text-slate-400 mt-2 font-mono truncate">{name}</p>
      )}
    </div>
  );
}

// Progressive disclosure, per the PRD's own Level 1/2/3 output contract:
// Level 1 (always visible) is just the date + label. Clicking an entry
// expands Level 2 - the summary already sitting in ExtractedMeta (agenda/
// achieved/attendees) or, for a plain file, its source and added-date. A
// "Open source" link is Level 3 - a direct file:// deep link to the
// original document. Browsers increasingly block file:// navigation from an
// http(s) page for security reasons, so this is best-effort - the raw path
// is always shown alongside it so it can be copied and opened by hand.
const TIMELINE_DOT_STYLES = {
  meeting: "bg-teal",
  "task-created": "bg-slate-300",
  "task-done": "bg-emerald-500",
  "status-update": "bg-violet-500",
  "payroll-computed": "bg-amber-400",
  "payroll-approved": "bg-amber-600",
};

function truncateText(text, max) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

// Pulled out of ProjectTimeline so the Context Node's condensed "Recent
// Activity" list (top 4, newest first) and the full Project Timeline (every
// entry, oldest first) share one computation - two independent copies of
// this merge/label logic already drifted apart once this session (see the
// meeting-title dedup fix), not repeating that.
function buildTimelineEvents(topic, meetingMetadata, tasks, summaryHistory, workflowHistory) {
  const events = [];

  meetingMetadata.forEach((m) => {
    if (!m.meeting_date) return;
    // timeline_title comes from the backend's own _meeting_timeline_title
    // (views.py) - a short, specific label instead of the raw extracted
    // meeting_title/filename, which could run long and, since it's often
    // just the transcript file's own title line, differ only by case
    // between two recordings of "the same" meeting (already deduped
    // server-side too - see _dedupe_meetings).
    events.push({
      key: `meeting-${m.id}`,
      sortTs: new Date(String(m.meeting_date) + "T00:00:00").getTime(),
      dateLabel: formatMeetingDate(m.meeting_date),
      label: m.timeline_title || m.meeting_title || fileDisplayName(m),
      kind: "meeting",
      path: m.file_path || m.file?.path || "",
      detail: m,
    });
  });

  // Board updates: a task's own created_at is a real "added to the board"
  // event; for a task marked done, its updated_at is used as a "completed"
  // event - a reasonable proxy since there's no separate status-change
  // history table, not a claim that updated_at is exclusively a completion
  // timestamp.
  (tasks || [])
    .filter((t) => t.topic === topic.id || t.topic_name === topic.name)
    .forEach((t) => {
      if (t.created_at) {
        events.push({
          key: `task-created-${t.id}`,
          sortTs: new Date(t.created_at).getTime(),
          dateLabel: formatAdded(t.created_at),
          label: `Task added: ${t.title}`,
          kind: "task-created",
          path: "",
          detail: t,
        });
      }
      if (t.status === "done" && t.updated_at) {
        events.push({
          key: `task-done-${t.id}`,
          sortTs: new Date(t.updated_at).getTime(),
          dateLabel: formatAdded(t.updated_at),
          label: `Task completed: ${t.title}`,
          kind: "task-done",
          path: "",
          detail: t,
        });
      }
    });

  // Project status updates: every AI Context Brief ever generated, not just
  // the latest one - each is a snapshot of how the project's state read at
  // that point in time.
  (summaryHistory || []).forEach((s) => {
    if (!s.generated_at) return;
    // timeline_title/timeline_body come from the backend's own
    // _summary_timeline_entry (views.py) - a specific label ("Risk
    // flagged", "Next step update", etc.) derived from which sections this
    // brief actually filled in, instead of every entry saying the same
    // generic "Status update".
    const title = s.timeline_title || "Status update";
    const body = s.timeline_body || truncateText(s.current_state, 70) || "brief regenerated";
    events.push({
      key: `status-${s.id}`,
      sortTs: new Date(s.generated_at).getTime(),
      dateLabel: formatAdded(s.generated_at),
      label: `${title}: ${body}`,
      kind: "status-update",
      path: "",
      detail: s,
    });
  });

  // Payroll workflow runs - computed and (separately) approved.
  (workflowHistory || []).forEach((w) => {
    if (w.created_at) {
      events.push({
        key: `payroll-computed-${w.id}`,
        sortTs: new Date(w.created_at).getTime(),
        dateLabel: formatAdded(w.created_at),
        label: "Payroll computed",
        kind: "payroll-computed",
        path: "",
        detail: w,
      });
    }
    if (w.status === "approved" && w.approved_at) {
      events.push({
        key: `payroll-approved-${w.id}`,
        sortTs: new Date(w.approved_at).getTime(),
        dateLabel: formatAdded(w.approved_at),
        label: "Payroll approved",
        kind: "payroll-approved",
        path: "",
        detail: w,
      });
    }
  });

  events.sort((a, b) => a.sortTs - b.sortTs);
  return events;
}

// The compact, height-bounded sidebar column used on the Overview tab, next
// to Context Node (the separate Timeline tab this once also powered was
// redundant with this column and was removed - see PROJECT_TABS above).
function ProjectTimeline({ topic, meetingMetadata, tasks, summaryHistory, workflowHistory }) {
  const [expandedKey, setExpandedKey] = useState(null);
  const events = buildTimelineEvents(topic, meetingMetadata, tasks, summaryHistory, workflowHistory);

  if (events.length === 0) return null;

  const isRealPath = (path) => path && !/^(pasted|mbox|ics):/.test(path);
  const fileHref = (path) => (isRealPath(path) ? `file:///${path.replace(/\\/g, "/")}` : null);

  return (
    <section
      id="project-timeline"
      className="rounded-lg border border-slate-200 bg-white p-3.5 scroll-mt-4 min-w-0 flex flex-col max-h-[calc(100vh-2rem)]"
    >
      <h2 className="text-sm font-semibold text-slate-700 mb-0.5 shrink-0">Project Timeline</h2>
      <p className="text-[11px] text-slate-400 mb-3 shrink-0">Click a title to expand.</p>
      {/* Bounded + independently scrollable - many more entries typically
          exist here than the Context Node has content for, so an unbounded
          sticky column just kept growing well past it. */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
        {events.map((e, i) => {
          const expanded = expandedKey === e.key;
          return (
            <div key={e.key} className="flex gap-2">
              <div className="flex flex-col items-center pt-1.5">
                <span className={`w-2 h-2 rounded-full shrink-0 ${TIMELINE_DOT_STYLES[e.kind] || "bg-slate-300"}`} />
                {i < events.length - 1 && <span className="w-px flex-1 bg-slate-200 my-1" />}
              </div>
              <div className="pb-3 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setExpandedKey(expanded ? null : e.key)}
                  className="text-left w-full group"
                >
                  <span className="block text-[10px] font-semibold text-slate-400 mb-0.5">
                    {e.dateLabel}
                  </span>
                  <span className="block text-[12.5px] font-medium text-slate-700 leading-snug group-hover:text-brand">
                    {e.label}
                  </span>
                </button>
                {expanded && (
                  <div className="mt-1.5 pl-2 border-l-2 border-slate-100 text-[11px] text-slate-600 space-y-1">
                    {e.kind === "meeting" && (
                      <>
                        {(e.detail.meeting_title || e.detail.file_display_name) && (
                          <p className="font-mono text-[11px] text-slate-400 truncate">
                            {e.detail.meeting_title || e.detail.file_display_name}
                          </p>
                        )}
                        {e.detail.attendees && e.detail.attendees.length > 0 && (
                          <p>
                            <span className="font-medium text-slate-500">Attendees: </span>
                            {e.detail.attendees.join(", ")}
                          </p>
                        )}
                        {e.detail.agenda && (
                          <p>
                            <span className="font-medium text-slate-500">Target: </span>
                            {e.detail.agenda}
                          </p>
                        )}
                        {e.detail.achieved && (
                          <p>
                            <span className="font-medium text-slate-500">Achieved: </span>
                            {e.detail.achieved}
                          </p>
                        )}
                      </>
                    )}
                    {(e.kind === "task-created" || e.kind === "task-done") && (
                      <>
                        {e.detail.assignee && (
                          <p>
                            <span className="font-medium text-slate-500">Assignee: </span>
                            {e.detail.assignee}
                          </p>
                        )}
                        {e.detail.due_date && (
                          <p>
                            <span className="font-medium text-slate-500">Due: </span>
                            {formatMeetingDate(e.detail.due_date)}
                          </p>
                        )}
                        <p>
                          <span className="font-medium text-slate-500">Status: </span>
                          {e.detail.status}
                        </p>
                      </>
                    )}
                    {e.kind === "status-update" && (
                      <>
                        {e.detail.why_now && (
                          <p>
                            <span className="font-medium text-slate-500">Why now: </span>
                            {e.detail.why_now}
                          </p>
                        )}
                        {e.detail.current_state && (
                          <p>
                            <span className="font-medium text-slate-500">Current state: </span>
                            {e.detail.current_state}
                          </p>
                        )}
                        {e.detail.next_step && (
                          <p>
                            <span className="font-medium text-slate-500">Next step: </span>
                            {e.detail.next_step}
                          </p>
                        )}
                      </>
                    )}
                    {(e.kind === "payroll-computed" || e.kind === "payroll-approved") && (
                      <p>
                        <span className="font-medium text-slate-500">Status: </span>
                        {e.detail.status === "approved" ? "Approved" : "Pending approval"}
                      </p>
                    )}
                    {isRealPath(e.path) && (
                      <p className="truncate">
                        <a
                          href={fileHref(e.path)}
                          className="text-teal-dark hover:underline"
                          title="May be blocked by your browser — the path below can be pasted into File Explorer directly."
                        >
                          Open source ↗
                        </a>
                        <span className="text-slate-400 font-mono ml-2">{e.path}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PayrollWorkflowPanel({ runs, computing, onCompute, onApprove }) {
  const latest = runs[0];
  const older = runs.slice(1);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold text-slate-700">Workflow — Payroll Approval</h2>
        <button
          onClick={onCompute}
          disabled={computing}
          className="px-3 py-1.5 text-xs rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
        >
          {computing ? "Computing…" : "Compute this month's hours"}
        </button>
      </div>

      {!latest && (
        <p className="text-xs text-slate-400">
          Not computed yet this session — click &ldquo;Compute this month&apos;s hours&rdquo; to
          aggregate employee hours found in this project&apos;s ingested files for the current
          month.
        </p>
      )}

      {latest && <PayrollRunCard run={latest} onApprove={onApprove} primary />}

      {older.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-slate-500 cursor-pointer select-none">
            {older.length} earlier computation{older.length === 1 ? "" : "s"} this session
          </summary>
          <div className="mt-2 space-y-3">
            {older.map((run) => (
              <PayrollRunCard key={run.id} run={run} onApprove={onApprove} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function PayrollRunCard({ run, onApprove, primary }) {
  const month = run.computed_data?.month;
  const employees = run.computed_data?.employees || [];

  return (
    <div className={`rounded-md border ${primary ? "border-slate-200" : "border-slate-100"} p-3`}>
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <span className="text-xs text-slate-500">
          {month ? `Month: ${month}` : "Computed"} · {formatAdded(run.created_at)}
        </span>
        {run.approved ? (
          <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
            Approved {formatAdded(run.approved_at)}
          </span>
        ) : (
          <button
            onClick={() => onApprove(run.id)}
            disabled={run.approving}
            className="px-2.5 py-1 text-[11px] rounded-md bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {run.approving ? "Approving…" : "Approve"}
          </button>
        )}
      </div>

      {employees.length === 0 ? (
        <p className="text-xs text-slate-400">
          No employee hours found in ingested files for this month.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-100">
                <th className="py-1 font-medium">Employee</th>
                <th className="py-1 font-medium text-right">Total hours</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp, idx) => (
                <Fragment key={emp.name || idx}>
                  <tr className="border-t border-slate-100">
                    <td className="py-1.5 font-medium text-slate-800">{emp.name}</td>
                    <td className="py-1.5 text-right font-mono text-slate-700">
                      {emp.total_hours}
                    </td>
                  </tr>
                  {emp.entries && emp.entries.length > 0 && (
                    <tr>
                      <td colSpan={2} className="pb-2">
                        <ul className="ml-1 space-y-0.5">
                          {emp.entries.map((en, i) => (
                            <li
                              key={i}
                              className="text-[11px] text-slate-500 flex justify-between gap-2"
                            >
                              <span className="shrink-0">
                                {en.date_unknown || !en.date ? "date unknown" : en.date}
                              </span>
                              <span className="font-mono shrink-0">{en.hours}h</span>
                              <span className="truncate text-slate-400">{en.source_file}</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
