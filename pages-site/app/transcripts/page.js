"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatAdded, TYPE_LABELS } from "../lib/format";

export const STATUS_STYLES = {
  routed: { label: "Routed", bg: "bg-teal-tint", text: "text-teal-dark" },
  auto_created: { label: "New project created", bg: "bg-brand-tint", text: "text-brand-dark" },
  needs_review: { label: "Needs review", bg: "bg-amber-50", text: "text-amber-700" },
  pre_existing: { label: "Pre-existing (not processed)", bg: "bg-[#f3f2ec]", text: "text-ink-muted" },
  error: { label: "Error", bg: "bg-red-50", text: "text-red-700" },
};

function sortNewestFirst(events) {
  return [...events].sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at));
}

export default function TranscriptsPage() {
  const [error, setError] = useState(null);
  const [events, setEvents] = useState([]);
  const [topics, setTopics] = useState([]);
  const [showPreExisting, setShowPreExisting] = useState(false);
  const [assigning, setAssigning] = useState({}); // eventId -> chosen topic id (string)
  const [drafts, setDrafts] = useState({}); // eventId -> {name, one_liner, topic_type} for pending suggestions

  function loadEvents() {
    api.getRecordingEvents().then(setEvents).catch((e) => setError(e.message));
  }

  useEffect(() => {
    api.listTopics().then(setTopics).catch(() => setTopics([]));
    loadEvents();
    // Recording events change on their own (the watcher runs in the
    // background, not from anything clicked on this page) - a light poll
    // keeps the feed current without a manual reload, same idea as the
    // scan-status polling used elsewhere in this app.
    const id = setInterval(loadEvents, 15000);
    return () => clearInterval(id);
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
    setDrafts((d) => ({ ...d, [eventId]: { ...draftFor({ id: eventId, ...d[eventId] }), ...d[eventId], ...patch } }));
  }

  async function handleConfirmNewProject(ev) {
    const draft = draftFor(ev);
    try {
      await api.confirmNewProject(ev.id, draft);
      loadEvents();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleRejectNewProject(ev) {
    try {
      await api.rejectNewProject(ev.id);
      loadEvents();
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleAssign(eventId) {
    const topicId = assigning[eventId];
    if (!topicId) return;
    try {
      await api.assignRecordingEvent(eventId, topicId);
      loadEvents();
    } catch (e) {
      setError(e.message);
    }
  }

  const pending = sortNewestFirst(events.filter((ev) => ev.status === "pending_new_project"));
  const routed = events.filter((ev) => ev.topic && (ev.status === "routed" || ev.status === "auto_created"));
  const other = sortNewestFirst(
    events.filter((ev) => !ev.topic && ev.status !== "pre_existing" && ev.status !== "pending_new_project")
  );
  const preExisting = events.filter((ev) => ev.status === "pre_existing");

  const groupsByTopic = {};
  for (const ev of routed) {
    if (!groupsByTopic[ev.topic]) groupsByTopic[ev.topic] = { topicId: ev.topic, topicName: ev.topic_name, events: [] };
    groupsByTopic[ev.topic].events.push(ev);
  }
  const projectGroups = Object.values(groupsByTopic)
    .map((g) => ({ ...g, events: sortNewestFirst(g.events) }))
    .sort((a, b) => new Date(b.events[0].detected_at) - new Date(a.events[0].detected_at));

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold text-[#1a1a1a] mb-1">Transcripts</h1>
      <p className="text-ink-muted text-sm mb-1">
        Recordings dropped into the shared Recordings folder are picked up automatically and
        transcribed, then grouped below by the project they belong to.
      </p>
      <p className="text-ink-muted text-sm mb-8">
        Configure the watched folder and transcription engine on the{" "}
        <Link href="/settings" className="text-teal-dark hover:underline">
          Settings page
        </Link>
        .
      </p>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {pending.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted mb-3">
            Needs your decision ({pending.length})
          </h2>
          <div className="flex flex-col gap-3">
            {pending.map((ev) => {
              const draft = draftFor(ev);
              return (
                <div key={ev.id} className="rounded-lg border-2 border-dashed border-brand/40 bg-brand-tint/30 px-4 py-3.5">
                  <p className="text-xs font-medium text-ink-muted mb-2 truncate" title={ev.file_name}>
                    {ev.file_name} · {formatAdded(ev.detected_at)}
                  </p>
                  <p className="text-sm text-[#1a1a1a] mb-3">
                    This recording looks like it might be a <strong>new project</strong> — not yet
                    tracked in OrientMe. Review the suggested name below, then confirm or dismiss.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-2 mb-2">
                    <input
                      className="rounded-md border border-border-warm px-3 py-2 text-sm bg-white"
                      value={draft.name}
                      onChange={(e) => setDraft(ev.id, { name: e.target.value })}
                      placeholder="Project name"
                    />
                    <select
                      className="rounded-md border border-border-warm px-3 py-2 text-sm bg-white"
                      value={draft.topic_type}
                      onChange={(e) => setDraft(ev.id, { topic_type: e.target.value })}
                    >
                      {Object.entries(TYPE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    className="w-full rounded-md border border-border-warm px-3 py-2 text-sm bg-white mb-3"
                    value={draft.one_liner}
                    onChange={(e) => setDraft(ev.id, { one_liner: e.target.value })}
                    placeholder="One-line description"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleConfirmNewProject(ev)}
                      disabled={!draft.name.trim()}
                      className="px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
                    >
                      Create project
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRejectNewProject(ev)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md border border-border-warm text-ink-muted hover:bg-white"
                    >
                      Not a new project
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {projectGroups.map((group) => (
        <section key={group.topicId} className="mb-6">
          <Link href={`/topics/?id=${encodeURIComponent(group.topicId)}`} className="inline-block mb-2">
            <h2 className="text-sm font-bold text-[#1a1a1a] hover:text-teal-dark hover:underline">
              {group.topicName} <span className="text-ink-muted font-normal">({group.events.length})</span>
            </h2>
          </Link>
          <div className="flex flex-col gap-2">
            {group.events.map((ev) => {
              const style = STATUS_STYLES[ev.status] || STATUS_STYLES.needs_review;
              return (
                <div key={ev.id} className="rounded-lg border border-border-warm bg-white px-4 py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/transcripts/${ev.id}`}
                      className="text-sm font-medium text-[#1a1a1a] hover:text-teal-dark hover:underline truncate block"
                      title={ev.file_name}
                    >
                      {ev.file_name}
                    </Link>
                    <p className="text-xs text-ink-muted mt-0.5">{formatAdded(ev.detected_at)}</p>
                  </div>
                  <span className={`shrink-0 text-[11px] font-semibold px-2 py-1 rounded-full ${style.bg} ${style.text}`}>
                    {style.label}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">
            Other meetings {other.length > 0 && `(${other.length})`}
          </h2>
          {preExisting.length > 0 && (
            <button
              type="button"
              onClick={() => setShowPreExisting((v) => !v)}
              className="text-xs font-medium text-teal-dark hover:underline"
            >
              {showPreExisting ? "Hide" : "Show"} {preExisting.length} from before auto-watch was turned on
            </button>
          )}
        </div>

        {other.length === 0 && !showPreExisting && (
          <p className="text-sm text-ink-muted border border-dashed border-border-warm rounded-lg px-4 py-6 text-center">
            Nothing here — recordings that don&apos;t belong to any tracked project will show up here.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {[...other, ...(showPreExisting ? preExisting : [])].map((ev) => {
            const style = STATUS_STYLES[ev.status] || STATUS_STYLES.needs_review;
            return (
              <div key={ev.id} className="rounded-lg border border-border-warm bg-white px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/transcripts/${ev.id}`}
                      className="text-sm font-medium text-[#1a1a1a] hover:text-teal-dark hover:underline truncate block"
                      title={ev.file_name}
                    >
                      {ev.file_name}
                    </Link>
                    <p className="text-xs text-ink-muted mt-0.5">{formatAdded(ev.detected_at)}</p>
                  </div>
                  <span className={`shrink-0 text-[11px] font-semibold px-2 py-1 rounded-full ${style.bg} ${style.text}`}>
                    {style.label}
                  </span>
                </div>
                {ev.detail && <p className="text-xs text-ink-muted mt-2">{ev.detail}</p>}
                {ev.status === "needs_review" && (
                  <div className="flex items-center gap-2 mt-2">
                    <select
                      className="rounded-md border border-border-warm px-2 py-1.5 text-sm bg-white"
                      value={assigning[ev.id] || ""}
                      onChange={(e) => setAssigning({ ...assigning, [ev.id]: e.target.value })}
                    >
                      <option value="">Assign to project…</option>
                      {topics.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!assigning[ev.id]}
                      onClick={() => handleAssign(ev.id)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
                    >
                      Assign
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
