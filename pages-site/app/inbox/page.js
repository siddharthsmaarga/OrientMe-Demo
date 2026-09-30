"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import TopicAutocomplete from "../components/TopicAutocomplete";

const SOURCE_METHOD_LABELS = {
  folder: "Lookup folder",
  upload: "Uploaded",
  folder_upload: "Uploaded folder",
  paste: "Pasted",
  email_import: "Email import",
  calendar_import: "Calendar import",
};

function formatAdded(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function basename(pathLike) {
  if (!pathLike) return pathLike;
  const parts = pathLike.split(/[\\/]/);
  return parts[parts.length - 1] || pathLike;
}

// Static-demo port of the real app's Inbox page: same UI, but backed by the
// in-memory demo store (see api.js's inbox methods) instead of Django. Two
// honest differences: "Open" can't launch a local app from a web page, so it
// shows a demo notice instead; and "Ask / Summarize" runs plain code over the
// file's text (no AI model).
//
// Inbox's own page - deliberately NOT the shared project-detail page
// (Context Node, Project Timeline, Edit Project, Calendar, Manage sources,
// Export/Import). Inbox mixes files from unrelated projects by definition,
// so none of that makes sense here (Ayush, 30 Sep, looking at exactly that
// page rendered for Inbox: "these are also not that required in inbox...
// some other options are required for those files operation"). This is a
// plain file manager instead: one row per file, with the only operations
// that actually make sense on a single, possibly-unrelated file - read its
// own summary, ask a question about just it, or move it into a real
// project once you know which one it belongs to.
export default function InboxPage() {
  const [topics, setTopics] = useState([]);
  const [openNotice, setOpenNotice] = useState(null); // fileId whose "Open" was clicked
  const [files, setFiles] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [expandedId, setExpandedId] = useState(null);
  const [questionDrafts, setQuestionDrafts] = useState({}); // fileId -> string
  const [answers, setAnswers] = useState({}); // fileId -> {answer, is_llm, generation_note}
  const [asking, setAsking] = useState({}); // fileId -> bool
  const [movingTo, setMovingTo] = useState({}); // fileId -> topic id string
  const [moving, setMoving] = useState({}); // fileId -> bool
  const [deleting, setDeleting] = useState({}); // fileId -> bool

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMoveTo, setBulkMoveTo] = useState("");

  async function load() {
    setLoading(true);
    try {
      setTopics(await api.listTopics());
      setFiles(await api.getInboxFiles());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => basename(f.display_name).toLowerCase().includes(q));
  }, [files, query]);

  async function handleAsk(fileId, question) {
    setAsking((a) => ({ ...a, [fileId]: true }));
    try {
      const result = await api.askInboxFile(fileId, question);
      setAnswers((a) => ({ ...a, [fileId]: result }));
    } catch (e) {
      setAnswers((a) => ({ ...a, [fileId]: { answer: `Couldn't get an answer: ${e.message}`, is_llm: false } }));
    } finally {
      setAsking((a) => ({ ...a, [fileId]: false }));
    }
  }

  async function handleMove(fileId) {
    const topicId = movingTo[fileId];
    if (!topicId) return;
    setMoving((m) => ({ ...m, [fileId]: true }));
    try {
      await api.moveFile(fileId, topicId);
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
    } catch (e) {
      setError(e.message);
      setMoving((m) => ({ ...m, [fileId]: false }));
    }
  }

  function dropFromState(ids) {
    const idSet = new Set(ids);
    setFiles((prev) => prev.filter((f) => !idSet.has(f.id)));
    setSelectedIds((s) => new Set([...s].filter((id) => !idSet.has(id))));
  }

  async function handleDelete(fileId) {
    setDeleting((d) => ({ ...d, [fileId]: true }));
    try {
      await api.deleteFile(fileId);
      dropFromState([fileId]);
    } catch (e) {
      setError(e.message);
      setDeleting((d) => ({ ...d, [fileId]: false }));
    }
  }

  function toggleSelected(fileId) {
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      await api.bulkDeleteFiles(ids);
      dropFromState(ids);
    } catch (e) {
      setError(e.message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkMove(topicId) {
    const ids = [...selectedIds];
    if (ids.length === 0 || !topicId) return;
    setBulkBusy(true);
    try {
      await api.bulkMoveFiles(ids, topicId);
      dropFromState(ids);
      setBulkMoveTo("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-10 w-full">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-[#1a1a1a]">Inbox</h1>
        <p className="text-ink-muted mt-1">
          Files that didn&apos;t confidently match a project — not necessarily related to each
          other, so there&apos;s no combined summary here.
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">
          {error}
        </div>
      )}

      <input
        type="text"
        placeholder="Filter by file name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full mb-4 rounded-md border border-border-warm px-3 py-2 text-sm bg-white"
      />

      {loading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-ink-muted border border-dashed border-border-warm rounded-lg px-4 py-10 text-center">
          {files.length === 0
            ? "Nothing in Inbox — files land here when they don't confidently match an existing project."
            : "No files match that filter."}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 flex-wrap text-xs mb-1">
            <label className="flex items-center gap-1.5 text-ink-muted cursor-pointer">
              <input
                type="checkbox"
                checked={filtered.length > 0 && filtered.every((f) => selectedIds.has(f.id))}
                onChange={() =>
                  setSelectedIds(
                    filtered.every((f) => selectedIds.has(f.id)) ? new Set() : new Set(filtered.map((f) => f.id))
                  )
                }
              />
              Select all shown
            </label>
            {selectedIds.size > 0 && (
              <>
                <span className="text-ink-muted">{selectedIds.size} selected</span>
                <TopicAutocomplete
                  topics={topics}
                  value={bulkMoveTo}
                  onChange={(id) => {
                    setBulkMoveTo(id);
                    handleBulkMove(id);
                  }}
                  placeholder="Move selected to project…"
                />
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={handleBulkDelete}
                  className="px-2.5 py-1 font-medium rounded-md bg-slate-100 text-slate-600 hover:bg-red-500 hover:text-white disabled:opacity-50"
                >
                  {bulkBusy ? "Working…" : `Delete selected (${selectedIds.size})`}
                </button>
              </>
            )}
          </div>

          {filtered.map((f) => {
            const isOpen = expandedId === f.id;
            const answer = answers[f.id];
            return (
              <div
                key={f.id}
                className={`rounded-lg border bg-white px-4 py-3 ${
                  selectedIds.has(f.id) ? "border-teal ring-1 ring-teal/30" : "border-border-warm"
                }`}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(f.id)}
                      onChange={() => toggleSelected(f.id)}
                      className="shrink-0"
                      aria-label={`Select ${f.display_name}`}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[#1a1a1a] truncate" title={f.path}>
                        {basename(f.display_name)}
                      </p>
                      <p className="text-xs text-ink-muted mt-0.5">
                        {SOURCE_METHOD_LABELS[f.source_method] || f.source_method} · added{" "}
                        {formatAdded(f.first_added_at)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      aria-disabled="true"
                      title="Opens the file in its default app in the full app - not available in this demo"
                      onClick={() => setOpenNotice(openNotice === f.id ? null : f.id)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md border border-border-warm text-ink-muted opacity-60 hover:bg-cream"
                    >
                      Open
                    </button>
                    <TopicAutocomplete
                      topics={topics}
                      value={movingTo[f.id] || ""}
                      onChange={(id) => setMovingTo((m) => ({ ...m, [f.id]: id }))}
                      placeholder="Move to project…"
                    />
                    <button
                      type="button"
                      disabled={!movingTo[f.id] || moving[f.id]}
                      onClick={() => handleMove(f.id)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
                    >
                      {moving[f.id] ? "Moving…" : "Move"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setExpandedId(isOpen ? null : f.id)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md border border-border-warm text-ink-muted hover:bg-cream"
                    >
                      {isOpen ? "Close" : "Ask / Summarize"}
                    </button>
                    <button
                      type="button"
                      title="Delete this file"
                      disabled={deleting[f.id]}
                      onClick={() => handleDelete(f.id)}
                      className="w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:bg-red-500 hover:text-white disabled:opacity-50"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {openNotice === f.id && (
                  <p className="mt-2 text-[11px] text-amber-700">
                    Demo only: in the full app this opens the file in Word, Excel, your PDF viewer, etc.
                  </p>
                )}

                {isOpen && (
                  <div className="mt-3 pt-3 border-t border-border-warm">
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="text"
                        value={questionDrafts[f.id] ?? ""}
                        onChange={(e) => setQuestionDrafts((d) => ({ ...d, [f.id]: e.target.value }))}
                        placeholder="Ask about just this file… (leave blank to just summarize it)"
                        className="flex-1 rounded-md border border-border-warm px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        disabled={asking[f.id]}
                        onClick={() => handleAsk(f.id, questionDrafts[f.id] || "")}
                        className="px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
                      >
                        {asking[f.id] ? "Asking…" : "Ask"}
                      </button>
                    </div>
                    {answer && (
                      <div className="rounded-md bg-cream/60 border border-border-warm px-3 py-2.5">
                        <p className="text-sm text-[#1a1a1a] whitespace-pre-wrap">{answer.answer.replace(/\*\*/g, "")}</p>
                        {!answer.is_llm && answer.generation_note && (
                          <p className="text-[11px] text-amber-700 mt-1.5">{answer.generation_note}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
