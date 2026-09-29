"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "../lib/api";

const KIND_STYLES = {
  meeting: { label: "Meeting", cls: "bg-teal-tint text-teal-dark border-teal-tint-strong" },
  task: { label: "Task added", cls: "bg-slate-100 text-slate-600 border-slate-200" },
  "task-done": { label: "Task completed", cls: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  status: { label: "Brief updated", cls: "bg-brand-tint text-brand border-brand/20" },
};

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

// A cross-project activity feed - meetings ingested, briefs refreshed, tasks
// added/completed, across every project, newest first. The per-project
// Timeline tab already answers "what happened on THIS project"; this answers
// "what happened anywhere I'm tracking."
export default function TimelinePage() {
  const [topics, setTopics] = useState([]);
  const [selectedTopic, setSelectedTopic] = useState("");
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.listTopics().then(setTopics).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    setLoading(true);
    api
      .getGlobalTimeline(selectedTopic || undefined)
      .then((data) => {
        setEvents(data);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [selectedTopic]);

  const grouped = useMemo(() => {
    const groups = [];
    let lastDate = null;
    for (const e of events) {
      if (e.date !== lastDate) {
        groups.push({ date: e.date, items: [] });
        lastDate = e.date;
      }
      groups[groups.length - 1].items.push(e);
    }
    return groups;
  }, [events]);

  return (
    <div className="max-w-4xl mx-auto px-6 py-10 w-full">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900">Timeline</h1>
        <p className="text-slate-500 mt-1">
          Everything that&apos;s happened across every project — meetings, task activity, and
          brief refreshes, newest first.
        </p>
      </header>

      <div className="mb-6">
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
      </div>

      {error && (
        <div className="mb-6 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">
          Couldn&apos;t reach the backend: {error}
        </div>
      )}

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : grouped.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <p>No activity yet — it will show up here as projects get meetings, tasks, and briefs.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map((group) => (
            <div key={group.date}>
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-3">
                {formatDate(group.date)}
              </div>
              <div className="space-y-2">
                {group.items.map((e, i) => {
                  const style = KIND_STYLES[e.kind] || KIND_STYLES.task;
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3"
                    >
                      <span
                        className={`shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full border ${style.cls}`}
                      >
                        {style.label}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-slate-800 truncate">{e.title}</p>
                        <Link
                          href={`/topics/?id=${encodeURIComponent(e.topic_id)}`}
                          className="text-xs text-teal-dark hover:underline"
                        >
                          {e.topic_name}
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
