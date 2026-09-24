"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { TYPE_LABELS, TYPE_STYLES } from "../lib/format";
import { topicHref } from "../lib/paths";

// The dashboard retains the supplied project-card layout and the full app's
// manual empty-project form, while storing created records in this browser.
function daysSince(isoDate) {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / 86400000;
}

const EMPTY_FORM = { name: "", topic_type: "project", one_liner: "", related_people: "" };

export default function Dashboard() {
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [staleAfterDays, setStaleAfterDays] = useState(14);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);

  async function load() {
    try {
      const [topicsData, settingsData] = await Promise.all([
        api.listTopics(),
        api.getSettings().catch(() => null),
      ]);
      setTopics(topicsData);
      const parsed = parseInt(settingsData?.stale_after_days, 10);
      if (!Number.isNaN(parsed)) setStaleAfterDays(parsed);
      setError(null);
    } catch {
      setError("Projects could not be loaded in this browser.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // Load once when the dashboard is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(event) {
    event.preventDefault();
    if (!form.name.trim()) {
      setError("Enter a project name to continue.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.createTopic(form);
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (createError) {
      setError(createError.message);
    } finally {
      setSaving(false);
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

      <p className="mb-6 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        This public demo saves projects in this browser only. Use fictional information; entries do not sync. Folder scanning, uploads, and AI-generated briefs require the full OrientMe app.
      </p>

      {!loading && (() => {
        const stale = topics.filter((topic) => daysSince(topic.last_activity_at) > staleAfterDays);
        const withRisks = topics.filter(
          (topic) => topic.latest_risks_and_gaps && daysSince(topic.last_activity_at) <= staleAfterDays
        );
        if (stale.length === 0 && withRisks.length === 0) return null;
        return (
          <section className="mb-8 rounded-lg border border-amber-200 bg-amber-50/60 p-4">
            <h2 className="text-sm font-semibold text-amber-900 mb-2">⚠ Needs attention</h2>
            <ul className="space-y-1.5">
              {withRisks.map((topic) => (
                <li key={`risk-${topic.id}`} className="text-sm">
                  <Link href={topicHref(topic.id)} className="font-medium text-amber-900 hover:underline">
                    {topic.name}
                  </Link>
                  <span className="text-amber-700"> — {topic.latest_risks_and_gaps}</span>
                </li>
              ))}
              {stale.map((topic) => (
                <li key={`stale-${topic.id}`} className="text-sm">
                  <Link href={topicHref(topic.id)} className="font-medium text-amber-900 hover:underline">
                    {topic.name}
                  </Link>
                  <span className="text-amber-700"> — no activity in {Math.floor(daysSince(topic.last_activity_at))} days</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })()}

      <section>
        <div className="flex items-center gap-3 mb-4">
          <button
            type="button"
            onClick={() => { setError(null); setShowForm((visible) => !visible); }}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-slate-300 text-slate-600 hover:border-teal transition-colors"
          >
            + Add empty project manually
          </button>
          <h2 className="text-lg font-semibold text-slate-900">Your projects</h2>
        </div>

        {showForm && (
          <form onSubmit={handleCreate} className="mb-6 max-w-2xl rounded-lg border border-slate-200 bg-slate-50 p-5 space-y-4">
            <div>
              <label htmlFor="project-name" className="block text-sm font-medium text-slate-700 mb-1">Name</label>
              <input
                id="project-name"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="e.g. Delivery planning review"
                required
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="project-type" className="block text-sm font-medium text-slate-700 mb-1">Type</label>
              <select
                id="project-type"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
                value={form.topic_type}
                onChange={(event) => setForm({ ...form, topic_type: event.target.value })}
              >
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="project-one-liner" className="block text-sm font-medium text-slate-700 mb-1">One-liner (optional)</label>
              <input
                id="project-one-liner"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={form.one_liner}
                onChange={(event) => setForm({ ...form, one_liner: event.target.value })}
                placeholder="What this is, in one line"
              />
            </div>
            <div>
              <label htmlFor="project-related-people" className="block text-sm font-medium text-slate-700 mb-1">Related people (optional)</label>
              <input
                id="project-related-people"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={form.related_people}
                onChange={(event) => setForm({ ...form, related_people: event.target.value })}
                placeholder="Comma-separated names"
              />
            </div>
            <p className="text-xs text-slate-400">
              This creates an empty project in this browser. Use the full app to add files and generate a brief.
            </p>
            <div className="flex gap-2">
              <button type="submit" disabled={saving} className="px-4 py-2 text-sm rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50">
                {saving ? "Creating…" : "Create project"}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setError(null); }}
                className="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-600"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {error && (
          <div role="alert" className="mb-4 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-slate-400 text-sm">Loading…</p>
        ) : topics.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-400">No projects yet — add an empty project to get started.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
            {topics.map((topic) => (
              <Link
                key={topic.id}
                href={topicHref(topic.id)}
                className="rounded-lg border border-slate-200 bg-white p-5 hover:border-teal hover:shadow-sm transition-all flex flex-col"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-semibold text-slate-900 text-base truncate">{topic.name}</span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mb-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TYPE_STYLES[topic.topic_type] || "bg-slate-100 text-slate-700"}`}>
                    {TYPE_LABELS[topic.topic_type] || topic.topic_type}
                  </span>
                </div>
                {topic.one_liner && <p className="text-sm text-slate-500 flex-1 line-clamp-2">{topic.one_liner}</p>}
                {topic.related_people && <p className="text-xs text-slate-400 mt-2 truncate">Related: {topic.related_people}</p>}
                <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-xs text-slate-400">{topic.file_count} {topic.file_count === 1 ? "file" : "files"} ingested</span>
                  <span className="text-xs font-medium text-teal-dark">View →</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
