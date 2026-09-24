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

function formatMeetingDate(iso) {
  if (!iso) return "No date";
  const d = new Date(String(iso) + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function CalendarPage() {
  const [topics, setTopics] = useState([]);
  const [selectedTopic, setSelectedTopic] = useState("");
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  useEffect(() => {
    api.listTopics().then(setTopics).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    setLoading(true);
    api
      .getCalendar(selectedTopic || undefined)
      .then((data) => {
        setMeetings(data);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [selectedTopic]);

  const sorted = useMemo(() => {
    return [...meetings].sort((a, b) => {
      const ad = a.meeting_date || "";
      const bd = b.meeting_date || "";
      if (ad && bd) return bd.localeCompare(ad);
      if (ad) return -1;
      if (bd) return 1;
      return 0;
    });
  }, [meetings]);

  function toggle(key) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-10 w-full">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900">Calendar</h1>
        <p className="text-slate-500 mt-1">
          Meetings extracted automatically from every project&apos;s ingested files, across the
          whole workspace or filtered to one project.
        </p>
      </header>

      <div className="mb-6">
        <label className="block text-sm font-medium text-slate-700 mb-1">Project</label>
        <select
          className="w-full max-w-xs rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
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
      ) : sorted.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <p>No meetings found yet — extracted automatically once you add data to a project.</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {sorted.map((m, i) => {
            // Backend may nest topic info under "topic" ({id, name,
            // topic_type}) or return it flat as topic_id/topic_name/
            // topic_type (its actual current shape) - check both.
            const topicId = m.topic?.id ?? m.topic_id;
            const topicName = m.topic?.name ?? m.topic_name;
            const topicType = m.topic?.topic_type ?? m.topic_type;
            const key = m.id ?? `${topicId ?? "?"}-${m.meeting_date ?? ""}-${m.meeting_title ?? ""}-${i}`;
            const isOpen = expanded.has(key);
            const attendees = Array.isArray(m.attendees) ? m.attendees : [];
            const hasDetail = attendees.length > 0 || m.agenda || m.achieved;
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => hasDetail && toggle(key)}
                  className={`w-full text-left flex items-center gap-3 px-5 py-4 hover:bg-slate-50 ${
                    hasDetail ? "cursor-pointer" : "cursor-default"
                  }`}
                >
                  <span className="text-xs text-slate-500 w-32 shrink-0">
                    {formatMeetingDate(m.meeting_date)}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                      TYPE_STYLES[topicType] || "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {TYPE_LABELS[topicType] || topicType || "Project"}
                  </span>
                  <span className="text-xs text-slate-400 shrink-0 truncate max-w-[9rem]">
                    {topicName}
                  </span>
                  <span className="font-medium text-slate-900 truncate flex-1">
                    {m.meeting_title || "Untitled meeting"}
                  </span>
                  {m.meeting_time && (
                    <span className="text-xs text-slate-400 shrink-0">{m.meeting_time}</span>
                  )}
                  {hasDetail && (
                    <span className="text-xs text-cyan-700 shrink-0">
                      {isOpen ? "Hide" : "Details"}
                    </span>
                  )}
                </button>
                {isOpen && hasDetail && (
                  <div className="px-5 pb-4 -mt-1">
                    {attendees.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-2">
                        {attendees.map((a, ai) => (
                          <span
                            key={ai}
                            className="text-[11px] text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full"
                          >
                            {a}
                          </span>
                        ))}
                      </div>
                    )}
                    {m.agenda && (
                      <p className="text-xs text-slate-600 mt-1">
                        <span className="font-medium text-slate-500">Agenda: </span>
                        {m.agenda}
                      </p>
                    )}
                    {m.achieved && (
                      <p className="text-xs text-slate-600 mt-1">
                        <span className="font-medium text-slate-500">Achieved: </span>
                        {m.achieved}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
