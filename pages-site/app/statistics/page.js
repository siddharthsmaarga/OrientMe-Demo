"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";

const TILES = [
  { key: "topics", label: "Projects" },
  { key: "files", label: "Files ingested" },
  { key: "meetings", label: "Meetings found" },
  { key: "tasks_backlog", label: "Tasks — backlog" },
  { key: "tasks_in_progress", label: "Tasks — in progress" },
  { key: "tasks_done", label: "Tasks — completed" },
];

// Plain aggregate counts, genuinely computable from what's already stored -
// no invented metrics, matching the earlier reports' "no specific dashboard
// numbers we can't actually stand behind" convention, now applied to a real
// live dashboard instead of a static report.
export default function StatisticsPage() {
  const [stats, setStats] = useState(null);
  const [topics, setTopics] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.getStats(), api.listTopics(), api.getTasks()])
      .then(([statsData, topicsData, tasksData]) => {
        setStats(statsData);
        setTopics(topicsData);
        setTasks(tasksData);
      })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="max-w-5xl 2xl:max-w-6xl mx-auto px-6 py-10 w-full">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900">Statistics</h1>
        <p className="text-slate-500 mt-1">A live count of what OrientMe has captured so far.</p>
      </header>

      {error && <p className="text-red-600 text-sm">Error: {error}</p>}
      {!stats && !error && <p className="text-slate-400 text-sm">Loading…</p>}

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          {TILES.map((tile) => (
            <div key={tile.key} className="rounded-lg border border-slate-200 bg-white p-5">
              <p className="text-3xl font-semibold text-slate-900 tabular-nums">
                {stats[tile.key] ?? 0}
              </p>
              <p className="text-xs text-slate-500 mt-1">{tile.label}</p>
            </div>
          ))}
        </div>
      )}

      {topics.length > 0 && <ProjectTaskBars topics={topics} tasks={tasks} />}
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}

// Hand-rolled stacked bars (no charting library) - same "plain CSS bars"
// convention this workspace already uses elsewhere (Weekly Summary Agent,
// HR Hiring Agent's own hand-rolled heatmap/progress bars).
function ProjectTaskBars({ topics, tasks }) {
  const rows = topics
    .map((t) => {
      const ts = tasks.filter((task) => task.topic === t.id);
      const backlog = ts.filter((x) => x.status === "backlog").length;
      const inProgress = ts.filter((x) => x.status === "in_progress").length;
      const done = ts.filter((x) => x.status === "done").length;
      return { id: t.id, name: t.name, backlog, inProgress, done, total: backlog + inProgress + done };
    })
    .sort((a, b) => b.total - a.total);

  const max = Math.max(1, ...rows.map((r) => r.total));

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h2 className="text-sm font-semibold text-slate-700">Tasks by project</h2>
        <div className="flex items-center gap-4 text-[11px] text-slate-500">
          <LegendDot color="bg-slate-300" label="Backlog" />
          <LegendDot color="bg-amber-400" label="In progress" />
          <LegendDot color="bg-emerald-500" label="Completed" />
        </div>
      </div>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.id}>
            <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
              <span className="font-medium truncate">{r.name}</span>
              <span className="text-slate-400 tabular-nums">
                {r.total} task{r.total === 1 ? "" : "s"}
              </span>
            </div>
            <div className="h-3 rounded-full bg-slate-100 overflow-hidden flex">
              {r.total > 0 && (
                <>
                  <div
                    style={{ width: `${(r.backlog / max) * 100}%` }}
                    className="bg-slate-300 h-full"
                  />
                  <div
                    style={{ width: `${(r.inProgress / max) * 100}%` }}
                    className="bg-amber-400 h-full"
                  />
                  <div style={{ width: `${(r.done / max) * 100}%` }} className="bg-emerald-500 h-full" />
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
