"use client";

import Link from "next/link";
import { Fragment, use, useEffect, useRef, useState } from "react";
import { api, API_BASE } from "../../lib/api";
import {
  formatAdded,
  formatMeetingDate,
  projectUrgency,
  TYPE_LABELS,
  TYPE_STYLES,
  URGENCY_STYLES,
} from "../../lib/format";
import CalendarWidget from "../../components/CalendarWidget";

const FETCH_TABS = [
  { key: "folder", label: "Lookup folder" },
  { key: "upload", label: "Upload file" },
  { key: "folderUpload", label: "Upload folder" },
  { key: "paste", label: "Paste text" },
  { key: "more", label: "More sources" },
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
// speaker labels - "Ayush", "Ayush Sinha", "Ayush Sinha A" (real, confirmed
// bug: all three showed up as separate stakeholders). A shorter name whose
// every word appears in a longer name is the same person named less fully -
// keep only the longest (most complete) version. Whole-word matching (not
// substring) so "Ayush" and "Ayushi" - a genuinely different person - never
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

export default function TopicDetail({ params }) {
  const { id } = use(params);
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
    loadSummary();
    loadSummaryHistory();
    loadWorkflowHistory();
  }

  useEffect(() => {
    load();
    refreshExtras();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleRefreshSummary() {
    setRefreshingSummary(true);
    try {
      const s = await api.refreshSummary(id);
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

  async function handleFileUpload(file) {
    if (!file) return;
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
          <h1 className="text-lg font-semibold text-slate-900 truncate">{topic.name}</h1>
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
                <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Brief
                </div>
                <button
                  type="button"
                  onClick={() => { handleExportBrief(); setDataMenuOpen(false); }}
                  className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                >
                  ↓ Full page snapshot (.md)
                </button>
                <a
                  href={`${API_BASE}/topics/${id}/export_brief_md/`}
                  onClick={() => setDataMenuOpen(false)}
                  className="block px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                  title="AI Context Brief fields only - also drops a copy into this project's own folder"
                >
                  ↓ AI brief only (.md)
                </a>
                <a
                  href={`${API_BASE}/topics/${id}/export_summary_csv/`}
                  onClick={() => setDataMenuOpen(false)}
                  className="block px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                >
                  ↓ AI brief fields (.csv)
                </a>
                <button
                  type="button"
                  onClick={() => { summaryCsvInputRef.current?.click(); setDataMenuOpen(false); }}
                  disabled={importingSummaryCsv}
                  className="w-full text-left px-3 py-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {importingSummaryCsv ? "Importing…" : "↑ Import edited brief (.csv)"}
                </button>
                <div className="mt-1 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 border-t border-border-warm">
                  Tasks
                </div>
                <a
                  href={`${API_BASE}/topics/${id}/export_tasks_csv/`}
                  onClick={() => setDataMenuOpen(false)}
                  className="block px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                >
                  ↓ Tasks (.csv)
                </a>
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

      {/* One scrollable reading column - no fixed side chat drawer anymore
          (removed per direct product feedback: no fragmented chat surface
          inside OrientMe itself; asking questions about a project's data
          stays a backend capability, not a UI here - see api.ask()). */}
      <div>
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
          {topic.one_liner && <p className="text-slate-500 -mt-2">{topic.one_liner}</p>}

          {topic.files.length === 0 && (
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
          )}

          {/* 1. Executive summary, always first. */}
          <ContextBriefPanel
            summary={summary}
            refreshing={refreshingSummary}
            onRefresh={handleRefreshSummary}
            hasFiles={topic.files.length > 0}
            files={topic.files}
          />

          {/* 2. Who this involves. */}
          <StakeholdersCard meetingMetadata={meetingMetadata} relatedPeople={topic.related_people} />

          {/* 3. Chronological meeting info, then the combined meetings+files
              timeline, then the calendar/payroll views built on the same data. */}
          {meetingMetadata.length > 0 && (
            <section className="rounded-lg border border-slate-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-slate-700 mb-3">Meeting Info</h2>
              <div className="flex flex-wrap gap-3">
                {meetingMetadata.map((m) => (
                  <div key={m.id} className="flex-1 min-w-[220px]">
                    <MeetingInfoCard entry={m} />
                  </div>
                ))}
              </div>
            </section>
          )}

          <ProjectTimeline
            topic={topic}
            meetingMetadata={meetingMetadata}
            tasks={tasks}
            summaryHistory={summaryHistory}
            workflowHistory={workflowHistory}
          />

          {topic.topic_type === "process" && (
            <PayrollWorkflowPanel
              runs={payrollRuns}
              computing={computingPayroll}
              onCompute={handleComputePayroll}
              onApprove={handleApprovePayroll}
            />
          )}
        </div>
      </div>

      {calendarModalOpen && (
        <CalendarModal onClose={() => setCalendarModalOpen(false)}>
          <CalendarWidget events={calendarEvents} />
        </CalendarModal>
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
                      .txt, .md, .docx, .pdf, .xlsx, .pptx
                    </p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileUpload(file);
                      }}
                      disabled={uploading}
                      className="hidden"
                    />
                  </div>
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

// The Sybill-style pre-meeting brief pattern, generalized: "current state" +
// "next move" at a glance, persisted (CaseSummary) so it doesn't need a
// fresh question typed into chat every time this page is opened. Every real
// chat answer also refreshes this automatically (see handleAsk) - the
// button is only for "I haven't asked anything yet, generate one now".
// Same 7-section order/labels as the backend's own _BRIEF_SECTION_LABELS
// (views.py) - kept in sync deliberately so the dashboard, the exported
// Markdown, and the Wox/Raycast HTML brief page never disagree on shape.
const BRIEF_SECTIONS = [
  ["why_now", "Why now"],
  ["current_state", "Current state"],
  ["history", "History"],
  ["customer_thoughts", "What the customer thinks"],
  ["promises_made", "Commitments & open loops"],
  ["next_step", "Recommended next step"],
  ["risks_and_gaps", "Risks & gaps"],
];

function ContextBriefPanel({ summary, refreshing, onRefresh, hasFiles, files }) {
  const byPath = Object.fromEntries((files || []).map((f) => [f.path, f]));
  const fieldSources = summary?.field_sources || {};

  function EditLinks({ paths }) {
    const matched = (paths || []).map((p) => byPath[p]).filter(Boolean);
    if (matched.length === 0) return null;
    return (
      <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
        {matched.map((f) => (
          <a
            key={f.id}
            href={`${API_BASE}/files/${f.id}/open/`}
            target="_blank"
            rel="noreferrer"
            title={`Open ${f.display_name || f.path} in its own application to edit it`}
            className="text-[11px] text-brand hover:underline whitespace-nowrap"
          >
            {(f.display_name || f.path).split(/[\\/]/).pop()} · Edit ↗
          </a>
        ))}
      </p>
    );
  }

  return (
    <section className="rounded-lg border border-brand/30 bg-brand/[0.03] p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-sm font-semibold text-brand">AI Context Brief</h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing || !hasFiles}
          title={hasFiles ? "Regenerate from the latest ingested files" : "Add files first"}
          className="text-xs font-medium text-brand hover:underline disabled:opacity-40 disabled:no-underline shrink-0"
        >
          {refreshing ? "Refreshing…" : "↻ Refresh brief"}
        </button>
      </div>

      {!summary && (
        <p className="text-xs text-slate-500">
          {hasFiles
            ? 'No brief generated yet — click "Refresh brief", or just ask a question in chat.'
            : "Add some files, then generate a brief — this is where the current state and recommended next move will show up automatically."}
        </p>
      )}

      {summary && (
        <div className="space-y-2.5">
          {summary.answer_summary && (
            <p className="text-sm text-slate-800 font-medium">{summary.answer_summary}</p>
          )}

          {/* "Open first" - the 3-5 most valuable things to look at before
              diving into the sections below, per the PRD's own output
              contract - previously generated by the LLM but never actually
              shown anywhere on this page. */}
          {summary.sources_used?.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Open first
              </p>
              <EditLinks paths={summary.sources_used} />
            </div>
          )}

          {BRIEF_SECTIONS.map(([key, label]) =>
            summary[key] ? (
              <div key={key}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {label}
                </p>
                <p className="text-sm text-slate-700 mt-0.5">{summary[key]}</p>
                <EditLinks paths={fieldSources[key]} />
              </div>
            ) : null
          )}

          <p className="text-[11px] text-slate-400 pt-1">
            Generated {formatAdded(summary.generated_at)}
          </p>
        </div>
      )}
    </section>
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
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-2">Key Stakeholders</h2>
      <div className="flex flex-wrap gap-1">
        {names.map((n) => (
          <span key={n} className="text-[11px] text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full">
            {n}
          </span>
        ))}
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

function ProjectTimeline({ topic, meetingMetadata, tasks, summaryHistory, workflowHistory }) {
  const [expandedKey, setExpandedKey] = useState(null);
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

  if (events.length === 0) return null;

  const isRealPath = (path) => path && !/^(pasted|mbox|ics):/.test(path);
  const fileHref = (path) => (isRealPath(path) ? `file:///${path.replace(/\\/g, "/")}` : null);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-3">Project Timeline</h2>
      <p className="text-xs text-slate-400 mb-3">
        Meetings, board activity, status updates, and payroll runs, in the order they happened.
        Click one to expand.
      </p>
      <div>
        {events.map((e, i) => {
          const expanded = expandedKey === e.key;
          return (
            <div key={e.key} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${
                    TIMELINE_DOT_STYLES[e.kind] || "bg-slate-300"
                  }`}
                />
                {i < events.length - 1 && <span className="w-px flex-1 bg-slate-200" />}
              </div>
              <div className="pb-3 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setExpandedKey(expanded ? null : e.key)}
                  className="text-left w-full group"
                >
                  <p className="text-[11px] text-slate-400">{e.dateLabel}</p>
                  <p className="text-sm text-slate-700 truncate group-hover:text-brand">
                    {e.label}
                  </p>
                </button>
                {expanded && (
                  <div className="mt-1.5 mb-1 pl-2 border-l-2 border-slate-100 text-xs text-slate-600 space-y-1">
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
