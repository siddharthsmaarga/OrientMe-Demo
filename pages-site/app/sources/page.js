"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

const TYPE_STYLES = {
  project: "bg-cyan-100 text-cyan-800",
  area: "bg-slate-100 text-slate-800",
  process: "bg-amber-100 text-amber-800",
  person: "bg-emerald-100 text-emerald-800",
  customer: "bg-purple-100 text-purple-800",
  opportunity: "bg-orange-100 text-orange-800",
};

const TYPE_LABELS = {
  project: "Project",
  area: "Area",
  process: "Process",
  person: "Person",
  customer: "Customer",
  opportunity: "Opportunity",
};

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

// Every ingested file across every project, one browsable library - the
// ingestion pipeline (folder scan / upload / paste / mailbox / ICS) is what
// OrientMe actually runs on, so it earns its own cross-project view instead
// of only being reachable one project's "Manage sources" modal at a time.
export default function SourcesPage() {
  const [topics, setTopics] = useState([]);
  const [selectedTopic, setSelectedTopic] = useState("");
  const [files, setFiles] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.listTopics().then(setTopics).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    setLoading(true);
    api
      .getAllSources(selectedTopic || undefined)
      .then((data) => {
        setFiles(data);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [selectedTopic]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter(
      (f) => f.display_name.toLowerCase().includes(q) || f.topic_name.toLowerCase().includes(q)
    );
  }, [files, query]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-10 w-full">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900">Sources</h1>
        <p className="text-slate-500 mt-1">
          Every file, meeting transcript, and pasted note ingested into any project — the raw
          material every brief and answer is grounded in.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap gap-3">
        <select
          className="rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
          value={selectedTopic}
          onChange={(e) => setSelectedTopic(e.target.value)}
        >
          <option value="">All projects</option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Filter by file or project name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 min-w-[200px] rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </div>

      {error && (
        <div className="mb-6 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">
          Couldn&apos;t reach the backend: {error}
        </div>
      )}

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <p>No sources found yet — add files to a project to see them here.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted border-b border-slate-100 bg-slate-50/60">
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Project</th>
                <th className="px-4 py-2.5">Source</th>
                <th className="px-4 py-2.5">Added</th>
                <th className="px-4 py-2.5">Type</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => (
                <tr key={f.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                  <td className="px-4 py-2.5 text-slate-800 truncate max-w-[320px]" title={f.display_name}>
                    {f.display_name}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        TYPE_STYLES[f.topic_type] || "bg-slate-100 text-slate-700"
                      }`}
                      title={TYPE_LABELS[f.topic_type] || f.topic_type}
                    >
                      {f.topic_name}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted">
                    {SOURCE_METHOD_LABELS[f.source_method] || f.source_method}
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted">{formatAdded(f.first_added_at)}</td>
                  <td className="px-4 py-2.5">
                    {f.artifact_type === "meeting" ? (
                      <span className="text-[10px] text-teal-dark bg-teal-tint border border-teal-tint-strong px-1.5 py-0.5 rounded-full">
                        Meeting
                      </span>
                    ) : f.artifact_type === "email" ? (
                      <span className="text-[10px] text-brand bg-brand-tint border border-brand/20 px-1.5 py-0.5 rounded-full">
                        Email
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-full">
                        File
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
