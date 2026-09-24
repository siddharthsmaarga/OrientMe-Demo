"use client";

import { useState } from "react";
import { formatMeetingDate } from "../lib/format";

// Month-grid calendar highlighting any day with a meeting or task due-date -
// used both on a single topic's page and the global /tasks page. No date
// library - plain JS Date math is enough for a month grid.
export default function CalendarWidget({ events }) {
  const [viewDate, setViewDate] = useState(() => new Date());
  const [selected, setSelected] = useState(null);

  const eventsByDate = {};
  events.forEach((e) => {
    (eventsByDate[e.date] = eventsByDate[e.date] || []).push(e);
  });

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  function dateStr(d) {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  const monthLabel = viewDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const selectedEvents = selected ? eventsByDate[selected] || [] : [];

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() => setViewDate(new Date(year, month - 1, 1))}
          className="text-slate-400 hover:text-slate-700 px-1"
          aria-label="Previous month"
        >
          ‹
        </button>
        <h2 className="text-lg font-semibold text-slate-700">{monthLabel}</h2>
        <button
          type="button"
          onClick={() => setViewDate(new Date(year, month + 1, 1))}
          className="text-slate-400 hover:text-slate-700 px-1"
          aria-label="Next month"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-sm font-medium text-slate-400 mb-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d == null) return <span key={i} />;
          const ds = dateStr(d);
          const hasEvent = !!eventsByDate[ds];
          const isSelected = selected === ds;
          return (
            <button
              key={i}
              type="button"
              onClick={() => hasEvent && setSelected(isSelected ? null : ds)}
              className={`aspect-square rounded-md text-lg flex items-center justify-center relative ${
                isSelected
                  ? "bg-brand text-white"
                  : hasEvent
                  ? "bg-teal-tint text-teal-dark font-medium hover:bg-teal-tint-strong cursor-pointer"
                  : "text-slate-400"
              }`}
            >
              {d}
              {hasEvent && !isSelected && (
                <span className="absolute bottom-0.5 w-1 h-1 rounded-full bg-teal" />
              )}
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
          <p className="text-sm font-medium text-slate-500">{formatMeetingDate(selected)}</p>
          {selectedEvents.length === 0 && (
            <p className="text-sm text-slate-400">Nothing on this day.</p>
          )}
          {selectedEvents.map((e, i) => (
            <p key={i} className="text-sm text-slate-700">
              {e.kind === "meeting" ? (
                <>
                  <span className="text-teal-dark font-medium">Meeting: </span>
                  {e.meeting_title || "Untitled meeting"}
                  {e.topic_name && <span className="text-slate-400"> ({e.topic_name})</span>}
                </>
              ) : (
                <>
                  <span className="text-amber-700 font-medium">Task: </span>
                  {e.title}
                  {e.assignee && <span className="text-slate-400"> — {e.assignee}</span>}
                  {e.topic_name && <span className="text-slate-400"> ({e.topic_name})</span>}
                </>
              )}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
