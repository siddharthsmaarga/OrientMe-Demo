"use client";

import { useState } from "react";
import { taskUrgency, URGENCY_STYLES } from "../lib/format";

export const TASK_COLUMNS = [
  { key: "backlog", label: "Backlog" },
  { key: "in_progress", label: "In Progress" },
  { key: "done", label: "Completed" },
];

// Topic-agnostic Kanban board - used both on a single topic's page (where
// every task already belongs to that topic) and on the global /tasks page
// (showTopic=true adds a small topic-name badge per card, since cards there
// span every topic at once). Urgency (the colored dot) is always computed
// automatically from due_date vs today (see lib/format.taskUrgency) - a
// person only ever edits the due date itself or drags the status column,
// never the color directly.
export default function TaskBoard({ tasks, onStatusChange, onDueDateChange, showTopic = false, emptyMessage }) {
  const [dragId, setDragId] = useState(null);

  function handleDrop(status) {
    if (dragId != null) {
      onStatusChange(dragId, status);
      setDragId(null);
    }
  }

  if (tasks.length === 0) {
    return (
      <p className="text-xs text-slate-400">
        {emptyMessage ||
          "No action items yet — they're pulled automatically from meeting transcripts once ingested."}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {TASK_COLUMNS.map((col) => (
        <div
          key={col.key}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => handleDrop(col.key)}
          className="rounded-md bg-slate-50 border border-slate-100 p-2 min-h-[120px]"
        >
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-xs font-semibold text-slate-600">{col.label}</span>
            <span className="text-[10px] text-slate-400">
              {tasks.filter((t) => t.status === col.key).length}
            </span>
          </div>
          <div className="space-y-2">
            {tasks
              .filter((t) => t.status === col.key)
              .map((t) => {
                const urgency = taskUrgency(t);
                const style = urgency ? URGENCY_STYLES[urgency] : null;
                return (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={() => setDragId(t.id)}
                    className="rounded-md bg-white border border-slate-200 px-2.5 py-2 text-xs shadow-sm cursor-move"
                  >
                    {showTopic && t.topic_name && (
                      <span className="inline-block text-[10px] font-medium text-teal-dark bg-teal-tint border border-teal-tint-strong px-1.5 py-0.5 rounded-full mb-1.5">
                        {t.topic_name}
                      </span>
                    )}
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
        </div>
      ))}
    </div>
  );
}
