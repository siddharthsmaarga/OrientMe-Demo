"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../lib/api";
import { formatAddedDate, formatTimeAgo, taskUrgency, toBullets, URGENCY_STYLES } from "../lib/format";

// The Overview tab's first screen - "at a glance" (Venki, 8 Oct 2026: "the
// first view should minimize all this clutter... the chronological timeline,
// whatever anchors, should come right in the beginning, in the very first
// viewport - one screenful... multiple lanes of info, right on top").
//
// One screenful, top to bottom:
//   1. Where we are (headline + the first few facts)  |  Needs attention
//   2. Timeline - the anchors (meetings, key documents, emails, notes), oldest
//      to newest, ending at today
//   3. Lanes - Next, Waiting on, Open questions, Action items
//
// Everything else the Overview used to show first (suggestion chips, the AI's
// longer sections, key-state counts, launchers, prompt history, the full
// timeline) is still there, just underneath this - nothing was removed.
// Unrelated files and folder details are deliberately not shown here.

const ANCHOR_DOT = {
  meeting: "bg-teal",
  document: "bg-indigo-500",
  email: "bg-sky-500",
  note: "bg-amber-500",
  "payroll-approved": "bg-amber-600",
  "payroll-computed": "bg-amber-400",
};
const ANCHOR_ICON = { meeting: "📅", document: "📄", email: "✉", note: "📝", "payroll-approved": "✔", "payroll-computed": "⚙" };
export const ANCHOR_KINDS = Object.keys(ANCHOR_DOT);
const MAX_ANCHORS = 10;
const LANE_LIMIT = 3;

function Card({ className = "", accent = "", children }) {
  return (
    <section className={`rounded-xl border border-border-warm bg-white shadow-sm min-w-0 ${accent} ${className}`}>
      {children}
    </section>
  );
}

function CardTitle({ children, right }) {
  return (
    <div className="flex items-center justify-between gap-2 mb-2">
      <h2 className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">{children}</h2>
      {right}
    </div>
  );
}

// Links to the file(s) a lane's facts were read from - the same "open it to
// edit it" shortcut the Context Node's bullets always had.
function SourceLinks({ paths, byPath }) {
  const matched = (paths || []).map((p) => byPath[p]).filter(Boolean).slice(0, 2);
  if (matched.length === 0) return null;
  const realName = (f) => (f.display_name || f.path).split(/[\\/]/).pop();
  // Say what the file IS; where two files would read the same, tell them apart
  // by their real file name.
  const labelOf = (f) => {
    const label = f.display_title || realName(f);
    return matched.filter((m) => (m.display_title || realName(m)) === label).length > 1 ? realName(f) : label;
  };
  return (
    <p className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5">
      {matched.map((f) => (
        <a
          key={f.id}
          href={`${API_BASE}/files/${f.id}/open/`}
          target="_blank"
          rel="noreferrer"
          title={`Open ${f.display_name || f.path} in its own application to edit it`}
          className="text-[11px] text-brand hover:underline truncate max-w-full"
        >
          {labelOf(f)} ↗
        </a>
      ))}
    </p>
  );
}

function Lane({ title, tint, count, items, paths, byPath, footer }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, LANE_LIMIT);
  const hidden = items.length - shown.length;
  return (
    <Card accent={`border-t-[3px] ${tint}`} className="p-3.5 flex flex-col">
      <CardTitle right={count != null ? <span className="text-[11px] text-slate-400">{count}</span> : null}>
        {title}
      </CardTitle>
      <ul className="space-y-1.5 flex-1">
        {shown.map((node, i) => (
          <li key={i} className="text-[13px] leading-snug text-slate-700 flex gap-1.5">
            <span className="text-slate-300 shrink-0">•</span>
            <span className={showAll ? "" : "line-clamp-2"}>{node}</span>
          </li>
        ))}
      </ul>
      {(hidden > 0 || (showAll && items.length > LANE_LIMIT)) && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1.5 self-start text-[11px] text-slate-500 hover:text-brand hover:underline"
        >
          {showAll ? "Show less" : `+${hidden} more`}
        </button>
      )}
      <SourceLinks paths={paths} byPath={byPath} />
      {footer}
    </Card>
  );
}

// What needs a person's eye, computed from data already on the page: overdue
// or soon-due commitments (the one record that still has a due date) and files
// that could not be read. Action items have no due date, so they never appear
// here as "overdue".
function buildAttention(commitments, files) {
  const items = [];
  (commitments || []).forEach((c) => {
    const urgency = taskUrgency(c);
    if (urgency !== "red" && urgency !== "yellow") return;
    items.push({
      key: `c-${c.id}`,
      rank: urgency === "red" ? 0 : 1,
      urgency,
      text: `${c.person}: ${c.commitment}`,
      tag: urgency === "red" ? "overdue" : "due soon",
      target: "commitments",
    });
  });
  const unreadable = (files || []).filter((f) => f.extraction_error);
  if (unreadable.length > 0) {
    const names = unreadable.slice(0, 2).map((f) => (f.display_name || f.path || "").split(/[\\/]/).pop());
    items.push({
      key: "unreadable",
      rank: 2,
      urgency: "yellow",
      text: `${unreadable.length} file${unreadable.length === 1 ? "" : "s"} couldn't be read — ${names.join(", ")}${unreadable.length > 2 ? "…" : ""}`,
      tag: "check",
      target: "sources",
    });
  }
  return items.sort((a, b) => a.rank - b.rank);
}

function AttentionCard({ items, onGoTo }) {
  const shown = items.slice(0, 4);
  const hidden = items.length - shown.length;
  return (
    <Card accent={items.length ? "border-l-4 border-l-accent-orange" : "border-l-4 border-l-accent-green"} className="p-4">
      <CardTitle>{items.length ? "⚠ Needs attention" : "Needs attention"}</CardTitle>
      {items.length === 0 ? (
        <p className="text-sm text-emerald-700 flex items-center gap-1.5">
          <span aria-hidden="true">✓</span> Nothing needs your attention right now.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((i) => {
            const style = URGENCY_STYLES[i.urgency];
            return (
              <li key={i.key}>
                <button
                  type="button"
                  onClick={() => onGoTo(i.target)}
                  className="w-full text-left flex gap-2 items-start group"
                >
                  <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
                  <span className="text-[13px] leading-snug text-slate-800 group-hover:underline line-clamp-2">
                    {i.text} <span className={`${style.text} font-medium`}>· {i.tag}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && <p className="text-[11px] text-slate-400 mt-1.5">+{hidden} more</p>}
    </Card>
  );
}

function WhereWeAre({ summary, projectState, refreshing, hasFiles, onRefresh, onOpenSources }) {
  const confirmed = (projectState?.current_position || "").trim();
  const allFacts = toBullets(summary?.current_state);
  // A person's confirmed position wins, then the AI's current objective, then
  // simply the first thing the brief says about where things stand.
  const objective = (summary?.why_now || "").trim();
  const headline = confirmed || objective || allFacts[0] || "";
  const facts = (confirmed || objective ? allFacts : allFacts.slice(1)).slice(0, 3);
  const stamp = confirmed
    ? `Confirmed by ${projectState.updated_by || "someone"}${projectState.updated_at ? ` · ${formatTimeAgo(projectState.updated_at)}` : ""}`
    : summary?.generated_at
      ? `AI brief · updated ${formatTimeAgo(summary.generated_at)}`
      : "";

  return (
    <Card accent="border-l-4 border-l-brand" className="p-4 md:col-span-2">
      <CardTitle
        right={
          <div className="flex items-center gap-3 shrink-0">
            {stamp && <span className="text-[11px] text-ink-muted">{stamp}</span>}
            <button
              type="button"
              onClick={() => onRefresh()}
              disabled={refreshing || !hasFiles}
              title={hasFiles ? "Regenerate from the latest ingested files" : "Add files first"}
              className="text-xs font-medium text-brand hover:underline disabled:opacity-40 disabled:no-underline"
            >
              {refreshing ? "Refreshing…" : "↻ Refresh"}
            </button>
          </div>
        }
      >
        Where we are
      </CardTitle>
      {headline ? (
        <p className="text-[15px] leading-snug font-medium text-slate-900 line-clamp-3">{headline}</p>
      ) : (
        <p className="text-sm text-slate-500">
          {hasFiles ? (
            'No brief yet — click "Refresh" to read this project\'s files, or state where things stand with "✎ Edit Project".'
          ) : (
            <>
              Nothing to summarise yet.{" "}
              <button type="button" onClick={onOpenSources} className="text-brand hover:underline font-medium">
                Add files
              </button>{" "}
              and this fills in automatically.
            </>
          )}
        </p>
      )}
      {facts.length > 0 && (
        <ul className="mt-2 space-y-1">
          {facts.map((f, i) => (
            <li key={i} className="text-[13px] leading-snug text-slate-600 flex gap-1.5">
              <span className="text-slate-300 shrink-0">•</span>
              <span className="line-clamp-2">{f}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Anchors({ anchors, onAnchorClick, onViewTimeline }) {
  const scroller = useRef(null);
  const [fadeLeft, setFadeLeft] = useState(false);

  // Newest anchors are the ones that matter most - start scrolled to the
  // right edge so "today" and the latest events are in view. Earlier ones sit
  // off to the left behind a soft fade (the cue for "scroll for more").
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const onScroll = () => setFadeLeft(el.scrollLeft > 4);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.scrollLeft = el.scrollWidth;
    return () => el.removeEventListener("scroll", onScroll);
  }, [anchors.length]);

  const fade = "linear-gradient(to right, transparent, #000 32px)";

  return (
    <Card className="px-4 pt-3 pb-3">
      <CardTitle
        right={
          <button type="button" onClick={onViewTimeline} className="text-xs font-medium text-brand hover:underline">
            Full timeline ↓
          </button>
        }
      >
        Timeline
      </CardTitle>
      {anchors.length === 0 ? (
        <p className="text-sm text-slate-500">
          The timeline fills in as meetings, emails and key documents are added to this project.
        </p>
      ) : (
        <div
          ref={scroller}
          className="overflow-x-auto pb-1 -mx-1 px-1"
          style={fadeLeft ? { WebkitMaskImage: fade, maskImage: fade } : undefined}
        >
          <ol className="flex min-w-max">
            {anchors.map((a, i) => {
              const latest = i === anchors.length - 1;
              return (
                <li key={a.key} className="relative w-44 shrink-0 border-t-2 border-slate-200 pt-3 pr-3">
                  <span
                    className={`absolute -top-[6px] left-0 w-2.5 h-2.5 rounded-full ring-2 ring-white ${ANCHOR_DOT[a.kind] || "bg-slate-300"}`}
                  />
                  <button type="button" onClick={() => onAnchorClick(a.key)} className="text-left w-full group">
                    <span className="block text-[10px] font-semibold text-slate-400">{a.dateLabel}</span>
                    <span
                      className={`block text-[12.5px] leading-snug line-clamp-2 group-hover:text-brand ${
                        latest ? "font-semibold text-slate-900" : "font-medium text-slate-700"
                      }`}
                    >
                      <span className="mr-1" aria-hidden="true">
                        {ANCHOR_ICON[a.kind]}
                      </span>
                      {a.label}
                    </span>
                  </button>
                </li>
              );
            })}
            <li className="relative w-20 shrink-0 border-t-2 border-dashed border-slate-200 pt-3">
              <span className="absolute -top-[6px] left-0 w-2.5 h-2.5 rounded-full bg-white ring-2 ring-slate-300" />
              <span className="block text-[10px] font-semibold text-slate-400">Today</span>
            </li>
          </ol>
        </div>
      )}
    </Card>
  );
}

export default function ProjectGlance({
  summary,
  projectState,
  commitments,
  tasks,
  files,
  anchors,
  refreshing,
  hasFiles,
  onRefresh,
  onOpenSources,
  onGoTo,
  onAnchorClick,
  onViewTimeline,
}) {
  const byPath = Object.fromEntries((files || []).map((f) => [f.path, f]));
  const fieldSources = summary?.field_sources || {};
  const attention = buildAttention(commitments, files);
  const openTasks = (tasks || []).filter((t) => t.status !== "done");
  const recentTasks = [...openTasks].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, LANE_LIMIT);

  const lanes = [
    { key: "next", title: "Next", tint: "border-t-teal", items: toBullets(summary?.next_step), paths: fieldSources.next_step },
    { key: "waiting", title: "Waiting on", tint: "border-t-amber-400", items: toBullets(summary?.promises_made), paths: fieldSources.promises_made },
    {
      key: "open",
      title: "Open questions",
      tint: "border-t-brand",
      items: toBullets(summary?.risks_and_gaps),
      paths: fieldSources.risks_and_gaps,
    },
  ].filter((l) => l.items.length > 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <WhereWeAre
          summary={summary}
          projectState={projectState}
          refreshing={refreshing}
          hasFiles={hasFiles}
          onRefresh={onRefresh}
          onOpenSources={onOpenSources}
        />
        <AttentionCard items={attention} onGoTo={(target) => (target === "sources" ? onOpenSources() : onGoTo(target))} />
      </div>

      <Anchors anchors={anchors} onAnchorClick={onAnchorClick} onViewTimeline={onViewTimeline} />

      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(230px,1fr))]">
        {lanes.map((l) => (
          <Lane
            key={l.key}
            title={l.title}
            tint={l.tint}
            count={l.items.length}
            items={l.items}
            paths={l.paths}
            byPath={byPath}
          />
        ))}
        <Lane
          title="Action items"
          tint="border-t-accent-green"
          count={openTasks.length ? `${openTasks.length} items` : null}
          items={
            recentTasks.length
              ? recentTasks.map((t) => (
                  <>
                    {t.title} <span className="text-[11px] text-slate-400">· added {formatAddedDate(t.created_at)}</span>
                  </>
                ))
              : [<span key="none" className="text-slate-400">Nothing open — action items are pulled from meeting transcripts.</span>]
          }
          byPath={byPath}
          footer={
            openTasks.length > 0 && (
              <button
                type="button"
                onClick={() => onGoTo("work")}
                className="mt-2 self-start text-[11px] font-medium text-brand hover:underline"
              >
                View all →
              </button>
            )
          }
        />
      </div>
    </div>
  );
}
