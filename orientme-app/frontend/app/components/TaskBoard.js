"use client";

import { useState } from "react";
import { formatAddedDate } from "../lib/format";
import TaskSourcePanel from "./TaskSourcePanel";

// Topic-agnostic action-item list - used both on a single topic's page
// (where every task already belongs to that topic) and on the global
// /tasks page (showTopic=true adds a small topic-name badge per row, since
// rows there span every topic at once). A plain divided list, not a grid
// of boxy cards (simplified again 30 Sep, per Ayush - the card-grid still
// "looked the same as a kanban board"; this is deliberately closer to a
// simple to-do list) and not a Kanban board either (removed earlier the
// same day - a drag-between-columns board reads as a full task-management
// system, which is exactly what Venki's own 30 Sep meeting said this app
// should NOT become: "the moment we go into these kind of features, this
// becomes a full task management system... we are not doing all that").
//
// An action item is just the action and the date it was added - no due date,
// no urgency colouring and no Backlog / In Progress / Completed status
// (Ayush, 8 Oct 2026). Clicking the action opens a small panel showing which
// transcript or file it was pulled from. (An item an older version marked
// done still shows struck through.)
export default function TaskBoard({ tasks, showTopic = false, emptyMessage }) {
  const [openId, setOpenId] = useState(null);

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
        const open = openId === t.id;
        return (
          <div key={t.id}>
            <div className="flex items-center gap-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : t.id)}
                aria-expanded={open}
                title="Where did this come from?"
                className={`flex-1 min-w-0 truncate text-left hover:underline decoration-slate-300 underline-offset-2 ${
                  t.status === "done" ? "text-slate-400 line-through" : "text-slate-800"
                }`}
              >
                {t.title}
              </button>
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
              <span className="text-[11px] text-slate-400 shrink-0 whitespace-nowrap">
                Added {formatAddedDate(t.created_at)}
              </span>
            </div>
            {open && <TaskSourcePanel taskId={t.id} />}
          </div>
        );
      })}
    </div>
  );
}
