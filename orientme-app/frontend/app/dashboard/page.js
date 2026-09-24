"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { projectUrgency, TYPE_LABELS, TYPE_STYLES, URGENCY_STYLES } from "../lib/format";

// PRD Should-have: "flag stale... information" - a topic nobody has
// touched (no fresh brief, no new file) in a while is easy to forget about
// across many projects; this is what actually surfaces that on the
// dashboard instead of requiring someone to open each one to check.
function daysSince(isoDate) {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / 86400000;
}

// Same shared progress bar as the topic page's manual scan/upload/import
// actions - "Orient this" runs the identical ScanJob-backed background job
// (see AutoCreateTopicView), so it deserves the same real-time feedback
// instead of a static "Setting up..." label with no visibility into
// whether it's 1/14 files in or actually stuck.
function ScanProgress({ job }) {
  if (!job) return null;
  const pct =
    job.total_files > 0
      ? Math.min(100, (job.processed_files / job.total_files) * 100)
      : job.status === "scanning"
        ? 15
        : 50;
  return (
    <div className="mt-2">
      <p className="text-[11px] text-slate-500 mb-1">
        {job.status === "scanning" ? "Reading files…" : "Extracting details & generating brief…"}
        {job.total_files > 0 && ` (${job.processed_files}/${job.total_files})`}
      </p>
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden max-w-2xl">
        <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// Project-list-first home page: adding a project is a deliberate, explicit
// action ("+ Add Project"), never a side effect of typing a question - that
// ambiguity ("looks like a chatbox, but chatting creates a project") is what
// the earlier chat-first version got direct, pointed feedback for. There is
// no cross-project chat surface anywhere in this app anymore (removed per
// direct product feedback: "I don't want my chat to be fragmented... this
// should be in the back end") - Ctrl/Cmd+K search (below) is navigation, not
// conversation, and stays for that reason.
export default function Dashboard() {
  const router = useRouter();
  const [topics, setTopics] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [staleAfterDays, setStaleAfterDays] = useState(14);

  const [showForm, setShowForm] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    topic_type: "project",
    one_liner: "",
    related_people: "",
  });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  // A list, not one string - "create project, then add folder #1, + to add
  // folder #2, #3..." - starts with one empty slot; the "+" button appends
  // another, so multiple folders can feed one project from the same form
  // instead of a separate trip to "Manage sources" per extra folder.
  const [autoProjectName, setAutoProjectName] = useState("");
  const [autoFolderPaths, setAutoFolderPaths] = useState([""]);
  const [autoCreating, setAutoCreating] = useState(false);
  const [autoScanJob, setAutoScanJob] = useState(null);

  function updateAutoFolderPath(index, value) {
    setAutoFolderPaths((paths) => paths.map((p, i) => (i === index ? value : p)));
  }
  function addAutoFolderSlot() {
    setAutoFolderPaths((paths) => [...paths, ""]);
  }
  function removeAutoFolderSlot(index) {
    setAutoFolderPaths((paths) => (paths.length > 1 ? paths.filter((_, i) => i !== index) : paths));
  }

  async function load() {
    setLoading(true);
    try {
      const [topicsData, tasksData, settingsData] = await Promise.all([
        api.listTopics(),
        api.getTasks(),
        api.getSettings().catch(() => null),
      ]);
      setTopics(topicsData);
      setTasks(tasksData);
      const parsedStaleDays = parseInt(settingsData?.stale_after_days, 10);
      if (!Number.isNaN(parsedStaleDays)) setStaleAfterDays(parsedStaleDays);
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

  async function handleAutoCreate(e) {
    e.preventDefault();
    const paths = autoFolderPaths.map((p) => p.trim()).filter(Boolean);
    if (paths.length === 0) return;
    setAutoCreating(true);
    setAutoScanJob(null);
    setError(null);
    try {
      const result = await api.autoCreateTopic(paths, autoProjectName.trim());
      // autoCreateTopic returns instantly with {topic_id, job_id} - scanning,
      // text extraction, AND the first AI brief all still run in the
      // background from here. Navigating immediately (the old behavior) sent
      // people to a topic page that could still 400 on "Refresh brief"
      // because nothing had finished yet - poll the same way the topic
      // page's own manual actions already do, and only navigate once done.
      const topicId = result.topic_id;
      const poll = async () => {
        let job;
        try {
          job = await api.getScanStatus(topicId);
        } catch (e) {
          setError(e.message);
          setAutoCreating(false);
          return;
        }
        setAutoScanJob(job);
        if (job.status === "done" || job.status === "error") {
          setAutoCreating(false);
          setAutoProjectName("");
          setAutoFolderPaths([""]);
          setAutoScanJob(null);
          router.push(`/topics/${topicId}`);
          return;
        }
        setTimeout(poll, 1200);
      };
      poll();
    } catch (e) {
      setError(e.message);
      setAutoCreating(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await api.createTopic(form);
      setForm({ name: "", topic_type: "project", one_liner: "", related_people: "" });
      setShowForm(false);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(e, topicId, topicName) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete "${topicName}"? This removes its files, tasks, and chat history too.`)) return;
    setDeletingId(topicId);
    try {
      await api.deleteTopic(topicId);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="max-w-6xl 2xl:max-w-[96rem] mx-auto px-6 py-10 w-full">
      <header className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight text-brand">OrientMe</h1>
        <p className="text-slate-500 mt-2">
          Your projects, at a glance — open one, or press Ctrl/Cmd+K to search across all of them.
        </p>
      </header>

      {!loading && (() => {
        const stale = topics.filter((t) => daysSince(t.last_activity_at) > staleAfterDays);
        const withRisks = topics.filter(
          (t) => t.latest_risks_and_gaps && daysSince(t.last_activity_at) <= staleAfterDays
        );
        if (stale.length === 0 && withRisks.length === 0) return null;
        return (
          <section className="mb-8 rounded-lg border border-amber-200 bg-amber-50/60 p-4">
            <h2 className="text-sm font-semibold text-amber-900 mb-2">⚠ Needs attention</h2>
            <ul className="space-y-1.5">
              {withRisks.map((t) => (
                <li key={`risk-${t.id}`} className="text-sm">
                  <Link href={`/topics/${t.id}`} className="font-medium text-amber-900 hover:underline">
                    {t.name}
                  </Link>
                  <span className="text-amber-700"> — {t.latest_risks_and_gaps}</span>
                </li>
              ))}
              {stale.map((t) => (
                <li key={`stale-${t.id}`} className="text-sm">
                  <Link href={`/topics/${t.id}`} className="font-medium text-amber-900 hover:underline">
                    {t.name}
                  </Link>
                  <span className="text-amber-700">
                    {" "}
                    — no activity in {Math.floor(daysSince(t.last_activity_at))} days
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })()}

      {/* Primary: the projects dashboard - full width, the main content of this page */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-slate-300 text-slate-600 hover:border-teal transition-colors"
          >
            + Add empty project manually
          </button>
          <h2 className="text-lg font-semibold text-slate-900">Your projects</h2>
        </div>

        {showForm && (
          <form
            onSubmit={handleCreate}
            className="mb-6 max-w-2xl rounded-lg border border-slate-200 bg-slate-50 p-5 space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. P&G Saudi Arabia opportunity"
                required
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Type</label>
              <select
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
                value={form.topic_type}
                onChange={(e) => setForm({ ...form, topic_type: e.target.value })}
              >
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                One-liner (optional)
              </label>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={form.one_liner}
                onChange={(e) => setForm({ ...form, one_liner: e.target.value })}
                placeholder="What this is, in one line"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Related people (optional)
              </label>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={form.related_people}
                onChange={(e) => setForm({ ...form, related_people: e.target.value })}
                placeholder="Comma-separated names"
              />
            </div>
            <p className="text-xs text-slate-400">
              Once created, open the project to add its files — transcripts, emails, notes.
            </p>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-sm rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
              >
                {saving ? "Creating…" : "Create project"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-600"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {error && (
          <div className="mb-4 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">
            Couldn&apos;t reach the backend: {error}. Is it running on port 8010?
          </div>
        )}

        {loading ? (
          <p className="text-slate-400 text-sm">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
            <button
              type="button"
              onClick={() => setCreateModalOpen(true)}
              className="rounded-lg border-2 border-dashed border-slate-300 bg-slate-50/50 p-5 flex flex-col items-center justify-center gap-2 text-slate-500 hover:border-teal hover:text-teal hover:bg-teal-50/30 transition-colors min-h-[140px]"
            >
              <span className="text-3xl leading-none font-light">+</span>
              <span className="text-sm font-medium">Create Project</span>
              <span className="text-xs text-slate-400 text-center">Point it at a folder — everything else is automatic</span>
            </button>

            {topics.length === 0 && (
              <div className="sm:col-span-2 lg:col-span-3 xl:col-span-4 2xl:col-span-5 text-center py-10 text-slate-400 text-sm">
                No projects yet — click &ldquo;Create Project&rdquo; to get started.
              </div>
            )}

            {topics.map((t) => {
              const urgency = projectUrgency(tasks.filter((task) => task.topic === t.id));
              const style = urgency ? URGENCY_STYLES[urgency] : null;
              return (
                <Link
                  key={t.id}
                  href={`/topics/${t.id}`}
                  className="relative rounded-lg border border-slate-200 bg-white p-5 hover:border-teal hover:shadow-sm transition-all flex flex-col"
                >
                  <button
                    type="button"
                    onClick={(e) => handleDelete(e, t.id, t.name)}
                    disabled={deletingId === t.id}
                    title="Delete project"
                    className="absolute top-3 right-3 text-slate-300 hover:text-red-600 disabled:opacity-50 text-xs leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-red-50"
                  >
                    ✕
                  </button>

                  <div className="flex items-center gap-2 mb-2 pr-5">
                    <span className="font-semibold text-slate-900 text-base truncate">{t.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap mb-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${TYPE_STYLES[t.topic_type] || "bg-slate-100 text-slate-700"}`}
                    >
                      {TYPE_LABELS[t.topic_type] || t.topic_type}
                    </span>
                    {style && (
                      <span
                        className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${style.bg} ${style.text} border ${style.border}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                        {style.label}
                      </span>
                    )}
                    {daysSince(t.last_activity_at) > staleAfterDays && (
                      <span
                        title={`No new brief or file in over ${staleAfterDays} days`}
                        className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800 border border-amber-200"
                      >
                        Stale
                      </span>
                    )}
                  </div>
                  {t.one_liner && (
                    <p className="text-sm text-slate-500 flex-1 line-clamp-2">{t.one_liner}</p>
                  )}
                  {t.related_people && (
                    <p className="text-xs text-slate-400 mt-2 truncate">Related: {t.related_people}</p>
                  )}
                  <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                    <span className="text-xs text-slate-400">
                      {t.file_count} {t.file_count === 1 ? "file" : "files"} ingested
                    </span>
                    <span className="text-xs font-medium text-teal-dark">View →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {createModalOpen && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
          onClick={() => !autoCreating && setCreateModalOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 pt-5">
              <h2 className="text-base font-semibold text-slate-900">Create a project</h2>
              {!autoCreating && (
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 text-lg leading-none"
                >
                  ×
                </button>
              )}
            </div>
            <form onSubmit={handleAutoCreate} className="p-5 space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Project name <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <input
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  value={autoProjectName}
                  onChange={(e) => setAutoProjectName(e.target.value)}
                  placeholder="Defaults to the first folder's own name"
                  disabled={autoCreating}
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Folder location{autoFolderPaths.length > 1 ? "s" : ""}
                </label>
                <div className="space-y-2">
                  {autoFolderPaths.map((path, i) => (
                    <div key={i} className="flex gap-2">
                      <input
                        className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm font-mono"
                        value={path}
                        onChange={(e) => updateAutoFolderPath(i, e.target.value)}
                        placeholder={
                          i === 0
                            ? "C:\\Users\\you\\OneDrive - Company\\Project Folder"
                            : "Another folder for this same project"
                        }
                        disabled={autoCreating}
                      />
                      {autoFolderPaths.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeAutoFolderSlot(i)}
                          disabled={autoCreating}
                          className="px-2.5 rounded-md border border-slate-300 text-slate-400 hover:text-red-500 hover:border-red-300 disabled:opacity-50 shrink-0"
                          title="Remove this folder"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={addAutoFolderSlot}
                  disabled={autoCreating}
                  className="mt-2 px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  + Add another folder
                </button>
              </div>

              <ScanProgress job={autoScanJob} />

              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={autoCreating || autoFolderPaths.every((p) => !p.trim())}
                  className="px-4 py-2 text-sm font-medium rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
                >
                  {autoCreating ? "Setting up…" : "Orient this"}
                </button>
                {!autoCreating && (
                  <button
                    type="button"
                    onClick={() => setCreateModalOpen(false)}
                    className="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-600"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
