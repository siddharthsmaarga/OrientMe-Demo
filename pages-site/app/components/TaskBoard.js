"use client";

import { taskUrgency, URGENCY_STYLES } from "../lib/format";

export const TASK_COLUMNS = [
  { key: "backlog", label: "Backlog" },
  { key: "in_progress", label: "In Progress" },
  { key: "done", label: "Completed" },
];

const STATUS_BADGE = {
  backlog: "bg-slate-100 text-slate-600",
  in_progress: "bg-amber-50 text-amber-700",
  done: "bg-emerald-50 text-emerald-700",
};

// Topic-agnostic action-item list - used both on a single topic's page
// (where every task already belongs to that topic) and on the global
// /tasks page (showTopic=true adds a small topic-name badge per row, since
// rows there span every topic at once). A plain divided list, not a grid
// of boxy cards (simplified again 30 Sep, ported from the same second pass
// in the real app - the card-grid still "looked the same as a kanban
// board"; this is deliberately closer to a simple to-do list) and not a
// Kanban board either (removed earlier the same day - a drag-between-columns
// board reads as a full task-management system, which is exactly what the
// product owner's own 30 Sep meeting said this app should NOT become).
// Status still changes (via the small select at the end of each row).
// Urgency (the colored dot) is always computed automatically from
// due_date vs today (see lib/format.taskUrgency).
export default function TaskBoard({ tasks, onStatusChange, onDueDateChange, showTopic = false, emptyMessage }) {
  if (tasks.length === 0) {
    return (
      <p className="text-xs text-slate-400">
        {emptyMessage ||
          "No action items yet — they're pulled automatically from meeting transcripts once ingested."}
      </p>
    );
  }

  return (
    <div className="divide-y divide-slate-100 border-t border-b border-slate-100">
      {tasks.map((t) => {
        const urgency = taskUrgency(t);
        const style = urgency ? URGENCY_STYLES[urgency] : null;
        return (
          <div key={t.id} className="flex items-center gap-3 py-2 text-xs">
            <span
              title={style ? style.label : "No due date"}
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${style ? style.dot : "bg-slate-200"}`}
            />
            <p className={`flex-1 min-w-0 truncate ${t.status === "done" ? "text-slate-400 line-through" : "text-slate-800"}`}>
              {t.title}
            </p>
            {showTopic && t.topic_name && (
              <span className="hidden sm:inline text-[11px] text-teal-dark shrink-0 truncate max-w-[9rem]">
                {t.topic_name}
              </span>
            )}
            {t.assignee && (
              <span className="hidden sm:inline text-[11px] text-slate-500 shrink-0 truncate max-w-[7rem]">
                {t.assignee}
              </span>
            )}
            <input
              type="date"
              value={t.due_date || ""}
              onChange={(e) => onDueDateChange && onDueDateChange(t.id, e.target.value)}
              className={`text-[11px] border border-transparent hover:border-slate-200 rounded px-1 py-0.5 bg-transparent shrink-0 ${
                style ? style.text : "text-slate-400"
              }`}
            />
            <select
              value={t.status}
              onChange={(e) => onStatusChange(t.id, e.target.value)}
              className={`text-[11px] rounded px-1.5 py-0.5 border-0 shrink-0 ${STATUS_BADGE[t.status] || STATUS_BADGE.backlog}`}
            >
              {TASK_COLUMNS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
