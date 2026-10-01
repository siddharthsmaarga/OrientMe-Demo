"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  formatRelativeDay,
  projectUrgency,
  recordingDisplayDate,
  TYPE_LABELS,
  URGENCY_STYLES,
} from "../lib/format";
import TopicAutocomplete from "../components/TopicAutocomplete";

function daysSince(isoDate) {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / 86400000;
}

const ACTIVITY_STYLES = {
  meeting: { label: "Meeting", dot: "bg-purple-400" },
  task: { label: "Task added", dot: "bg-slate-400" },
  "task-done": { label: "Task done", dot: "bg-emerald-500" },
  status: { label: "Status update", dot: "bg-teal-dark" },
};

// The enterprise-style landing page - product owner's own ask, 30 Sep: "make
// another page in the left pane called dashboard... move this drag and
// drop folder thing and new transcript... and all projects summary in a
// structured projects manner and other dashboard elements which
// enterprise level application has". "Projects" (/dashboard) stays a
// clean, focused browse/create/manage list; this is the at-a-glance
// pulse across everything - KPIs, what needs a decision right now, a
// structured (table, not card-grid) summary of every project's health,
// and a real cross-project activity feed (GlobalTimelineView, already
// built weeks ago and never actually wired into any page until now).
// Every manual-drop RecordingEvent status that still needs a person to look
// at it - "routed"/"auto_created"/"dismissed" need nothing further, and
// "pre_existing" only ever applies to the watched folder, never a manual
// drop.
const NEEDS_ATTENTION_STATUSES = ["needs_review", "pending_new_project", "error"];
const ATTENTION_DISPLAY_CAP = 10;

export default function HomeDashboard() {
  const [topics, setTopics] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [allCommitments, setAllCommitments] = useState([]);
  const [allRisks, setAllRisks] = useState([]);
  const [activity, setActivity] = useState([]);
  const [pendingRecordings, setPendingRecordings] = useState([]);
  const [staleAfterDays, setStaleAfterDays] = useState(14);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [assigning, setAssigning] = useState({});
  const [busy, setBusy] = useState({});
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkDismissing, setBulkDismissing] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [creatingNew, setCreatingNew] = useState({}); // eventId -> bool
  const [drafts, setDrafts] = useState({}); // eventId -> {name, one_liner, topic_type}

  async function load() {
    setLoading(true);
    try {
      const [topicsData, tasksData, settingsData, commitmentsData, risksData, recordingEvents, activityData] =
        await Promise.all([
          api.listTopics(),
          api.getTasks(),
          api.getSettings().catch(() => null),
          api.getCommitments().catch(() => []),
          api.getRisks().catch(() => []),
          api.getRecordingEvents().catch(() => []),
          api.getGlobalTimeline().catch(() => []),
        ]);
      setTopics(topicsData);
      setTasks(tasksData);
      setAllCommitments(commitmentsData);
      setAllRisks(risksData);
      setActivity(activityData);
      const parsedStaleDays = parseInt(settingsData?.stale_after_days, 10);
      if (!Number.isNaN(parsedStaleDays)) setStaleAfterDays(parsedStaleDays);
      // Manual drops only - watched-folder recordings needing review stay
      // on the Transcripts page (a different activity/source entirely; see
      // that page's own filtering + note pointing back here).
      setPendingRecordings(
        recordingEvents
          .filter((ev) => ev.source === "manual_drop" && NEEDS_ATTENTION_STATUSES.includes(ev.status))
          .sort((a, b) => new Date(recordingDisplayDate(b)) - new Date(recordingDisplayDate(a)))
      );
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function draftFor(ev) {
    return (
      drafts[ev.id] || {
        name: ev.suggested_topic_name || "",
        one_liner: ev.suggested_topic_one_liner || "",
        topic_type: ev.suggested_topic_type || "project",
      }
    );
  }

  function setDraft(eventId, patch) {
    setDrafts((d) => ({ ...d, [eventId]: { ...draftFor({ id: eventId }), ...d[eventId], ...patch } }));
  }

  async function handleAssignRecording(eventId) {
    const topicId = assigning[eventId];
    if (!topicId) return;
    setBusy((b) => ({ ...b, [eventId]: true }));
    try {
      await api.assignRecordingEvent(eventId, topicId);
      setPendingRecordings((prev) => prev.filter((ev) => ev.id !== eventId));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy((b) => ({ ...b, [eventId]: false }));
    }
  }

  async function handleCreateProjectFor(ev) {
    const draft = draftFor(ev);
    if (!draft.name.trim()) return;
    setBusy((b) => ({ ...b, [ev.id]: true }));
    try {
      await api.createProjectFromRecording(ev.id, draft);
      setCreatingNew((c) => ({ ...c, [ev.id]: false }));
      setPendingRecordings((prev) => prev.filter((e) => e.id !== ev.id));
      load(); // the new project should show up in All Projects immediately
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy((b) => ({ ...b, [ev.id]: false }));
    }
  }

  async function handleConfirmSuggested(ev) {
    setBusy((b) => ({ ...b, [ev.id]: true }));
    try {
      await api.confirmNewProject(ev.id, draftFor(ev));
      setPendingRecordings((prev) => prev.filter((e) => e.id !== ev.id));
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy((b) => ({ ...b, [ev.id]: false }));
    }
  }

  async function handleDismissRecording(eventId) {
    setBusy((b) => ({ ...b, [eventId]: true }));
    try {
      await api.dismissRecordingEvent(eventId);
      setPendingRecordings((prev) => prev.filter((ev) => ev.id !== eventId));
      setSelectedIds((s) => {
        if (!s.has(eventId)) return s;
        const next = new Set(s);
        next.delete(eventId);
        return next;
      });
    } catch (e) {
      setError(e.message);
      setBusy((b) => ({ ...b, [eventId]: false }));
    }
  }

  function toggleSelected(eventId) {
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }

  async function handleBulkDismiss(ids) {
    if (ids.length === 0) return;
    setBulkDismissing(true);
    try {
      await api.bulkDismissRecordingEvents(ids);
      const idSet = new Set(ids);
      setPendingRecordings((prev) => prev.filter((ev) => !idSet.has(ev.id)));
      setSelectedIds((s) => new Set([...s].filter((id) => !idSet.has(id))));
    } catch (e) {
      setError(e.message);
    } finally {
      setBulkDismissing(false);
    }
  }

  // Errored files (couldn't be read/processed) never need a per-file
  // decision - there's nothing to assign, only something to dismiss - so
  // they're collapsed into one unified summary rather than N separate
  // cards (product feedback, 30 Sep: "this list like thing is not required... should
  // be unified like a single thing"). Everything else still needs its own
  // card since each one really is a distinct decision (assign/create/move).
  const errorEvents = pendingRecordings.filter((ev) => ev.status === "error");
  const actionableRecordings = pendingRecordings.filter((ev) => ev.status !== "error");
  const visibleRecordings = actionableRecordings.slice(0, ATTENTION_DISPLAY_CAP);
  const allVisibleSelected =
    visibleRecordings.length > 0 && visibleRecordings.every((ev) => selectedIds.has(ev.id));

  const realProjects = topics;

  const openCommitmentsCount = allCommitments.filter((c) => c.status !== "done").length;
  const activeRisksCount = allRisks.filter((r) => r.status === "open").length;
  const totalFiles = realProjects.reduce((sum, t) => sum + (t.file_count || 0), 0);
  const openTasksCount = tasks.filter((t) => t.status !== "done").length;

  const stale = realProjects.filter((t) => daysSince(t.last_activity_at) > staleAfterDays);
  const withRisks = realProjects.filter(
    (t) => t.latest_risks_and_gaps && daysSince(t.last_activity_at) <= staleAfterDays
  );

  // Structured summary row per project - health/status derived the same
  // way the card grid already computes it (task urgency, staleness), just
  // rendered as a scannable table instead of a grid of boxes - "all
  // projects summary in a structured projects manner", distinct from the
  // free-browsing card grid that stays on the Projects page. No "Type"
  // column (product feedback, 30 Sep: "why its type... its only projects right") -
  // every real topic tracked here is a project, so a column that never
  // varies is just noise; "Last activity" instead shows WHAT that latest
  // activity actually was, not just when, pulled from the same global
  // timeline feed already loaded for the panel on the right.
  const latestActivityByTopic = {};
  for (const a of activity) {
    if (!latestActivityByTopic[a.topic_id]) latestActivityByTopic[a.topic_id] = a;
  }

  const projectRows = [...realProjects]
    .map((t) => {
      const urgency = projectUrgency(tasks.filter((task) => task.topic === t.id));
      const isStale = daysSince(t.last_activity_at) > staleAfterDays;
      return { topic: t, urgency, isStale, lastActivity: latestActivityByTopic[t.id] };
    })
    .sort((a, b) => {
      const rank = (r) => (r.urgency === "red" ? 0 : r.isStale ? 1 : r.urgency === "yellow" ? 2 : 3);
      return rank(a) - rank(b) || new Date(b.topic.last_activity_at || 0) - new Date(a.topic.last_activity_at || 0);
    });

  return (
    <div className="max-w-6xl 2xl:max-w-[96rem] mx-auto px-6 py-10 w-full">
      <header className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight text-brand">Dashboard</h1>
        <p className="text-ink-muted mt-2">Everything that needs your attention, at a glance.</p>
      </header>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">
          Couldn&apos;t reach the backend: {error}
        </div>
      )}

      {/* KPI strip */}
      {!loading && (
        <div className="mb-8 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KpiCard value={realProjects.length} label="active projects" accent="border-l-brand" />
          <KpiCard value={openTasksCount} label="open tasks" accent="border-l-teal-dark" />
          <KpiCard
            value={openCommitmentsCount}
            label="open commitments"
            accent={openCommitmentsCount > 0 ? "border-l-teal-dark" : "border-l-slate-200 opacity-70"}
            href="/actions"
          />
          <KpiCard
            value={activeRisksCount}
            label="active risks"
            accent={activeRisksCount > 0 ? "border-l-accent-orange" : "border-l-slate-200 opacity-70"}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 flex flex-col gap-8">
          <section>
            {/* Unreadable files - one unified notice, never a per-file list
                (product feedback, 30 Sep: "this list like thing is not required...
                should be unified like a single thing" - there's nothing to
                assign for any of these, only something to dismiss, so N
                individual cards was always more UI than the decision
                needed). Filenames are still there if wanted, just tucked
                behind a toggle instead of always taking up the page. */}
            {errorEvents.length > 0 && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-sm text-red-800">
                    <strong>{errorEvents.length}</strong> file{errorEvents.length === 1 ? "" : "s"} couldn&apos;t
                    be read (unsupported type, or no extractable content).
                  </p>
                  <div className="flex items-center gap-3 text-xs shrink-0">
                    <button
                      type="button"
                      onClick={() => setShowErrorDetails((v) => !v)}
                      className="font-medium text-red-700 hover:underline"
                    >
                      {showErrorDetails ? "Hide files" : "Show files"}
                    </button>
                    <button
                      type="button"
                      disabled={bulkDismissing}
                      onClick={() => handleBulkDismiss(errorEvents.map((ev) => ev.id))}
                      className="px-2.5 py-1 font-semibold rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {bulkDismissing ? "Dismissing…" : `Dismiss all (${errorEvents.length})`}
                    </button>
                  </div>
                </div>
                {showErrorDetails && (
                  <ul className="mt-2 pt-2 border-t border-red-200 space-y-1 max-h-48 overflow-y-auto">
                    {errorEvents.map((ev) => (
                      <li key={ev.id} className="text-xs text-red-700 flex items-center justify-between gap-2">
                        <span className="truncate" title={ev.file_name}>
                          {ev.file_name}
                        </span>
                        <button
                          type="button"
                          disabled={busy[ev.id]}
                          onClick={() => handleDismissRecording(ev.id)}
                          className="text-red-400 hover:text-red-700 shrink-0"
                          title="Dismiss just this one"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {actionableRecordings.length > 0 && (
              <div className="flex flex-col gap-2 mt-3">
                {/* Bulk actions for everything that DOES need a per-file
                    decision (needs_review/pending_new_project). */}
                <div className="flex items-center gap-3 flex-wrap text-xs">
                  <label className="flex items-center gap-1.5 text-ink-muted cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={() =>
                        setSelectedIds(
                          allVisibleSelected ? new Set() : new Set(visibleRecordings.map((ev) => ev.id))
                        )
                      }
                    />
                    Select all shown
                  </label>
                  {selectedIds.size > 0 && (
                    <button
                      type="button"
                      disabled={bulkDismissing}
                      onClick={() => handleBulkDismiss([...selectedIds])}
                      className="px-2.5 py-1 font-medium rounded-md bg-slate-100 text-slate-600 hover:bg-red-500 hover:text-white disabled:opacity-50"
                    >
                      {bulkDismissing ? "Dismissing…" : `Dismiss selected (${selectedIds.size})`}
                    </button>
                  )}
                </div>

                {visibleRecordings.map((ev) => (
                  <UploadReviewCard
                    key={ev.id}
                    ev={ev}
                    topics={topics}
                    draft={draftFor(ev)}
                    setDraft={(patch) => setDraft(ev.id, patch)}
                    creatingNew={!!creatingNew[ev.id]}
                    setCreatingNew={(v) => setCreatingNew((c) => ({ ...c, [ev.id]: v }))}
                    assigningTopic={assigning[ev.id] || ""}
                    setAssigningTopic={(id) => setAssigning((a) => ({ ...a, [ev.id]: id }))}
                    busy={!!busy[ev.id]}
                    selected={selectedIds.has(ev.id)}
                    onToggleSelected={() => toggleSelected(ev.id)}
                    onAssign={() => handleAssignRecording(ev.id)}
                    onCreateProject={() => handleCreateProjectFor(ev)}
                    onConfirmSuggested={() => handleConfirmSuggested(ev)}
                    onDismiss={() => handleDismissRecording(ev.id)}
                  />
                ))}
                {actionableRecordings.length > ATTENTION_DISPLAY_CAP && (
                  <p className="text-xs text-ink-muted text-center">
                    +{actionableRecordings.length - ATTENTION_DISPLAY_CAP} more — dismiss or assign some
                    above to see the rest.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Needs attention - moved here from Projects, same reasoning. */}
          {!loading && (stale.length > 0 || withRisks.length > 0) && (
            <section className="rounded-xl border border-border-warm border-l-4 border-l-accent-orange bg-white shadow-sm p-4">
              <h2 className="text-[15px] font-bold text-[#1a1a1a] mb-2">⚠ Needs attention</h2>
              <ul className="space-y-1.5">
                {withRisks.map((t) => (
                  <li key={`risk-${t.id}`} className="text-sm">
                    <Link href={`/topics/?id=${encodeURIComponent(t.id)}`} className="font-medium text-[#1a1a1a] hover:underline">
                      {t.name}
                    </Link>
                    <span className="text-ink-muted"> — {t.latest_risks_and_gaps}</span>
                  </li>
                ))}
                {stale.map((t) => (
                  <li key={`stale-${t.id}`} className="text-sm">
                    <Link href={`/topics/?id=${encodeURIComponent(t.id)}`} className="font-medium text-[#1a1a1a] hover:underline">
                      {t.name}
                    </Link>
                    <span className="text-ink-muted"> — no activity in {Math.floor(daysSince(t.last_activity_at))} days</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Structured projects summary - a table, not the card grid (that
              stays on Projects for browsing) - sorted worst-health first. */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[15px] font-bold text-[#1a1a1a]">All Projects</h2>
              <Link href="/dashboard" className="text-xs font-medium text-teal-dark hover:underline">
                Manage projects →
              </Link>
            </div>
            {loading ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : projectRows.length === 0 ? (
              <p className="text-sm text-ink-muted border border-dashed border-border-warm rounded-lg px-4 py-6 text-center">
                No projects yet.
              </p>
            ) : (
              <div className="rounded-lg border border-border-warm bg-white overflow-hidden">
                <table className="w-full text-sm table-fixed">
                  <thead>
                    <tr className="border-b border-border-warm bg-cream/60 text-left text-[11px] font-bold uppercase tracking-wider text-ink-muted">
                      <th className="px-4 py-2 w-40">Project</th>
                      <th className="px-4 py-2 w-28">Status</th>
                      <th className="px-4 py-2 w-16 hidden sm:table-cell">Files</th>
                      <th className="px-4 py-2">Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projectRows.map(({ topic: t, urgency, isStale, lastActivity }) => {
                      const style = urgency ? URGENCY_STYLES[urgency] : null;
                      return (
                        <tr key={t.id} className="border-b border-border-warm last:border-0 hover:bg-cream/40">
                          <td className="px-4 py-2.5">
                            <Link href={`/topics/?id=${encodeURIComponent(t.id)}`} className="font-medium text-[#1a1a1a] hover:text-teal-dark hover:underline truncate block">
                              {t.name}
                            </Link>
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {style && (
                                <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium ${style.bg} ${style.text} border ${style.border}`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                                  {style.label}
                                </span>
                              )}
                              {isStale && (
                                <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800 border border-amber-200">
                                  Stale
                                </span>
                              )}
                              {!style && !isStale && <span className="text-xs text-ink-muted">On track</span>}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 hidden sm:table-cell text-xs text-ink-muted">
                            {t.file_count}
                          </td>
                          <td className="px-4 py-2.5 text-xs min-w-0">
                            {lastActivity ? (
                              // Links straight to the project's own Project
                              // Timeline section (product feedback, 30 Sep: "when i
                              // click the last activity then it should show
                              // the activity details") - the #project-
                              // timeline anchor is the same section this
                              // title/date summary was built from, so
                              // clicking through shows the full, real entry
                              // (and every other one around it), not just a
                              // repeat of the one line already shown here.
                              <Link
                                href={`/topics/?id=${encodeURIComponent(t.id)}&tab=overview#project-timeline`}
                                className="block truncate hover:underline"
                                title="View this activity on the project's timeline"
                              >
                                <span className="text-[#1a1a1a]">{lastActivity.title}</span>
                                <span className="text-ink-muted"> · {formatRelativeDay(new Date(lastActivity.date).getTime())}</span>
                              </Link>
                            ) : (
                              <span className="text-ink-muted">
                                {t.last_activity_at ? formatRelativeDay(new Date(t.last_activity_at).getTime()) : "No activity yet"}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        {/* Cross-project activity feed - GlobalTimelineView already existed
            server-side and had no UI anywhere until now. */}
        <aside className="rounded-lg border border-border-warm bg-white p-4 h-fit lg:sticky lg:top-6">
          <h2 className="text-[15px] font-bold text-[#1a1a1a] mb-3">Recent Activity</h2>
          {loading ? (
            <p className="text-sm text-ink-muted">Loading…</p>
          ) : activity.length === 0 ? (
            <p className="text-sm text-ink-muted">Nothing yet — activity across every project will show up here.</p>
          ) : (
            <ul className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
              {activity.slice(0, 25).map((a, i) => {
                const style = ACTIVITY_STYLES[a.kind] || ACTIVITY_STYLES.status;
                return (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
                    <div className="min-w-0">
                      <p className="text-[#1a1a1a] leading-snug">{a.title}</p>
                      <p className="text-ink-muted mt-0.5">
                        <Link href={`/topics/?id=${encodeURIComponent(a.topic_id)}`} className="text-teal-dark hover:underline">
                          {a.topic_name}
                        </Link>{" "}
                        · {formatRelativeDay(new Date(a.date).getTime())}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

// One card per manual-drop RecordingEvent still needing a look - shape
// depends on its status: an unsupported/failed file just needs a Dismiss;
// needs_review/pending_new_project need an
// actual assign-or-create decision. Every variant gets a Dismiss - the
// real gap that prompted this (product feedback, 30 Sep, dropping a whole project
// folder of source files): "there is no option to remove these files".
function UploadReviewCard({
  ev,
  topics,
  draft,
  setDraft,
  creatingNew,
  setCreatingNew,
  assigningTopic,
  setAssigningTopic,
  busy,
  selected,
  onToggleSelected,
  onAssign,
  onCreateProject,
  onConfirmSuggested,
  onDismiss,
}) {
  // "error" is deliberately absent - it is never rendered as an individual
  // card (see the unified error summary in the parent component).
  const STATUS_BADGE = {
    needs_review: { label: "Needs review", bg: "bg-amber-50", text: "text-amber-700" },
    pending_new_project: { label: "Looks like a new project", bg: "bg-brand-tint", text: "text-brand-dark" },
  };
  const style = STATUS_BADGE[ev.status] || STATUS_BADGE.needs_review;

  return (
    <div
      className={`rounded-lg border bg-white px-4 py-3 ${selected ? "border-teal ring-1 ring-teal/30" : "border-border-warm"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-2">
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelected}
            className="mt-1 shrink-0"
            aria-label={`Select ${ev.file_name}`}
          />
          <div className="min-w-0">
            <Link
              href={`/transcripts/${ev.id}`}
              className="text-sm font-medium text-[#1a1a1a] hover:text-teal-dark hover:underline truncate block"
              title={ev.file_name}
            >
              {ev.file_name}
            </Link>
            {ev.detail && <p className="text-xs text-ink-muted mt-0.5">{ev.detail}</p>}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          <span className={`text-[11px] font-semibold px-2 py-1 rounded-full ${style.bg} ${style.text}`}>
            {style.label}
          </span>
          <button
            type="button"
            title="Dismiss - stop tracking this file"
            disabled={busy}
            onClick={onDismiss}
            className="w-5 h-5 flex items-center justify-center rounded-full bg-slate-100 text-slate-400 text-[11px] leading-none hover:bg-red-500 hover:text-white disabled:opacity-50"
          >
            ✕
          </button>
        </div>
      </div>

      {ev.status === "needs_review" &&
        (creatingNew ? (
          <div className="mt-3 rounded-md border border-dashed border-brand/40 bg-brand-tint/20 p-3">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-2 mb-2">
              <input
                className="rounded-md border border-border-warm px-3 py-2 text-sm bg-white"
                value={draft.name}
                onChange={(e) => setDraft({ name: e.target.value })}
                placeholder="Project name"
                autoFocus
              />
              <select
                className="rounded-md border border-border-warm px-3 py-2 text-sm bg-white"
                value={draft.topic_type}
                onChange={(e) => setDraft({ topic_type: e.target.value })}
              >
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <input
              className="w-full rounded-md border border-border-warm px-3 py-2 text-sm bg-white mb-2"
              value={draft.one_liner}
              onChange={(e) => setDraft({ one_liner: e.target.value })}
              placeholder="One-line description (optional)"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCreateProject}
                disabled={!draft.name.trim() || busy}
                className="px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
              >
                {busy ? "Creating…" : "Create project"}
              </button>
              <button
                type="button"
                onClick={() => setCreatingNew(false)}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-border-warm text-ink-muted hover:bg-white"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <TopicAutocomplete topics={topics} value={assigningTopic} onChange={setAssigningTopic} />
            <button
              type="button"
              disabled={!assigningTopic || busy}
              onClick={onAssign}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
            >
              {busy ? "Assigning…" : "Assign"}
            </button>
            <span className="text-xs text-ink-muted">or</span>
            <button
              type="button"
              onClick={() => setCreatingNew(true)}
              className="text-xs font-medium text-teal-dark hover:underline"
            >
              + Create new project
            </button>
          </div>
        ))}

      {ev.status === "pending_new_project" && (
        <div className="mt-3 rounded-md border border-dashed border-brand/40 bg-brand-tint/20 p-3">
          <p className="text-xs text-ink-muted mb-2">
            Not yet tracked in OrientMe - review the suggested name, then confirm or dismiss.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-2 mb-2">
            <input
              className="rounded-md border border-border-warm px-3 py-2 text-sm bg-white"
              value={draft.name}
              onChange={(e) => setDraft({ name: e.target.value })}
              placeholder="Project name"
            />
            <select
              className="rounded-md border border-border-warm px-3 py-2 text-sm bg-white"
              value={draft.topic_type}
              onChange={(e) => setDraft({ topic_type: e.target.value })}
            >
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <input
            className="w-full rounded-md border border-border-warm px-3 py-2 text-sm bg-white mb-2"
            value={draft.one_liner}
            onChange={(e) => setDraft({ one_liner: e.target.value })}
            placeholder="One-line description"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={onConfirmSuggested}
              disabled={!draft.name.trim() || busy}
              className="px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create project"}
            </button>
            <span className="text-xs text-ink-muted">or</span>
            <TopicAutocomplete topics={topics} value={assigningTopic} onChange={setAssigningTopic} />
            <button
              type="button"
              disabled={!assigningTopic || busy}
              onClick={onAssign}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
            >
              {busy ? "Assigning…" : "Assign to existing"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ value, label, accent, href }) {
  const content = (
    <>
      <p className="text-2xl font-bold text-[#1a1a1a] leading-none">{value}</p>
      <p className="text-xs text-ink-muted mt-1">{label}</p>
    </>
  );
  const className = `rounded-xl border border-border-warm border-l-4 bg-white shadow-sm px-4 py-3 ${accent}`;
  return href ? (
    <Link href={href} className={`${className} hover:shadow transition-shadow block`}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}
