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
// /tasks page (showTopic=true adds a small topic-name badge per card,
// since cards there span every topic at once). Deliberately a flat grid of
// rectangular cards, not a drag-and-drop Kanban board - ported from the
// same change in the real app, made because the product owner's own
// meeting was explicit that a Kanban board reads as a full task-management
// system, which this app deliberately isn't trying to become. Status still
// changes (via the select on each card), it just isn't the card's spatial
// position anymore. Urgency (the colored dot) is always computed
// automatically from due_date vs today (see lib/format.taskUrgency).
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
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {tasks.map((t) => {
        const urgency = taskUrgency(t);
        const style = urgency ? URGENCY_STYLES[urgency] : null;
        return (
          <div
            key={t.id}
            className="rounded-md bg-white border border-slate-200 px-3 py-2.5 text-xs shadow-sm"
          >
            <div className="flex items-center justify-between gap-2 mb-1.5">
              {showTopic && t.topic_name ? (
                <span className="inline-block text-[10px] font-medium text-teal-dark bg-teal-tint border border-teal-tint-strong px-1.5 py-0.5 rounded-full truncate">
                  {t.topic_name}
                </span>
              ) : (
                <span />
              )}
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_BADGE[t.status] || STATUS_BADGE.backlog}`}>
                {TASK_COLUMNS.find((c) => c.key === t.status)?.label || t.status}
              </span>
            </div>
            <div className="flex items-start gap-1.5">
              {style && (
                <span
                  title={style.label}
                  className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`}
                />
              )}
              <p className="text-slate-800 font-medium">{t.title}</p>
            </div>
            <div className="flex items-center justify-between mt-1.5 gap-2 flex-wrap">
              {t.assignee && (
                <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-full truncate">
                  {t.assignee}
                </span>
              )}
              <input
                type="date"
                value={t.due_date || ""}
                onChange={(e) => onDueDateChange && onDueDateChange(t.id, e.target.value)}
                className={`text-[10px] border border-slate-200 rounded px-1 py-0.5 bg-white ${
                  style ? style.text : "text-slate-500"
                }`}
              />
            </div>
            <select
              value={t.status}
              onChange={(e) => onStatusChange(t.id, e.target.value)}
              className="w-full mt-1.5 text-[10px] border border-slate-200 rounded px-1 py-0.5 bg-white"
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
