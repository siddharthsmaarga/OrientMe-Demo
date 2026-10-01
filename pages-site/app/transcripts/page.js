"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { TYPE_LABELS, formatAdded, recordingDisplayDate } from "../lib/format";
import TopicAutocomplete from "../components/TopicAutocomplete";

export const STATUS_STYLES = {
  routed: { label: "Routed", bg: "bg-teal-tint", text: "text-teal-dark" },
  auto_created: { label: "New project created", bg: "bg-brand-tint", text: "text-brand-dark" },
  needs_review: { label: "Needs review", bg: "bg-amber-50", text: "text-amber-700" },
  pre_existing: { label: "Pre-existing (not processed)", bg: "bg-[#f3f2ec]", text: "text-ink-muted" },
  error: { label: "Error", bg: "bg-red-50", text: "text-red-700" },
};

function sortNewestFirst(events) {
  return [...events].sort((a, b) => new Date(recordingDisplayDate(b)) - new Date(recordingDisplayDate(a)));
}

export default function TranscriptsPage() {
  const [error, setError] = useState(null);
  const [events, setEvents] = useState([]);
  const [topics, setTopics] = useState([]);
  const [showPreExisting, setShowPreExisting] = useState(false);
  const [assigning, setAssigning] = useState({}); // eventId -> chosen topic id (string)
  const [drafts, setDrafts] = useState({}); // eventId -> {name, one_liner, topic_type} for pending suggestions
  const [creatingNew, setCreatingNew] = useState({}); // eventId -> bool, showing the manual create-project form
  const [busy, setBusy] = useState({}); // eventId -> bool, in-flight manual action (create/assign)

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
    setBusy((b) => ({ ...b, [ev.id]: true }));
    try {
      await api.confirmNewProject(ev.id, draft);
      loadEvents();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy((b) => ({ ...b, [ev.id]: false }));
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
    setBusy((b) => ({ ...b, [eventId]: true }));
    try {
      await api.assignRecordingEvent(eventId, topicId);
      loadEvents();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy((b) => ({ ...b, [eventId]: false }));
    }
  }

  // The manual "create a project from this recording" path - available on
  // any not-yet-routed recording, not only ones the LLM already flagged as
  // a likely new project (see ev.status === "pre_existing" / "needs_review"
  // below). Re-transcribes on demand server-side if this recording was
  // never processed before (a "pre_existing" one, seeded before auto-watch
  // existed) - the person never has to run a separate "process it" step.
  async function handleCreateNew(ev) {
    const draft = draftFor(ev);
    if (!draft.name.trim()) return;
    setBusy((b) => ({ ...b, [ev.id]: true }));
    try {
      await api.createProjectFromRecording(ev.id, draft);
      setCreatingNew((c) => ({ ...c, [ev.id]: false }));
      loadEvents();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy((b) => ({ ...b, [ev.id]: false }));
    }
  }

  // Manual drops (a person dragging arbitrary files/folders into the
  // Dashboard's DropZone) are a different activity from this page's own
  // concept - recordings the watched folder picked up on its own. They
  // never belong here (product feedback, 30 Sep, after dropping a
  // whole project folder of source files: "whyyyy it is coming in
  // transcripts") - they're managed entirely on the Dashboard instead,
  // where they can actually be assigned/created-into/dismissed. See
  // home/page.js's "Needs your attention" uploads section.
  const watchedFolderEvents = events.filter((ev) => ev.source !== "manual_drop");
  const pending = sortNewestFirst(watchedFolderEvents.filter((ev) => ev.status === "pending_new_project"));
  const routed = watchedFolderEvents.filter(
    (ev) => ev.topic && (ev.status === "routed" || ev.status === "auto_created")
  );
  const other = sortNewestFirst(
    watchedFolderEvents.filter(
      (ev) => !ev.topic && ev.status !== "pre_existing" && ev.status !== "pending_new_project"
    )
  );
  const preExisting = watchedFolderEvents.filter((ev) => ev.status === "pre_existing");

  const groupsByTopic = {};
  for (const ev of routed) {
    if (!groupsByTopic[ev.topic]) groupsByTopic[ev.topic] = { topicId: ev.topic, topicName: ev.topic_name, events: [] };
    groupsByTopic[ev.topic].events.push(ev);
  }
  const projectGroups = Object.values(groupsByTopic)
    .map((g) => ({ ...g, events: sortNewestFirst(g.events) }))
    .sort((a, b) => new Date(recordingDisplayDate(b.events[0])) - new Date(recordingDisplayDate(a.events[0])));

  // Shared by both the "New Transcripts Found" list (other) and the
  // collapsed pre-existing list - same card, same assign/create-new
  // controls, just two different buckets of "hasn't been routed yet".
  function renderMeetingCard(ev) {
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
            <p className="text-xs text-ink-muted mt-0.5">{formatAdded(recordingDisplayDate(ev))}</p>
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            <span className={`text-[11px] font-semibold px-2 py-1 rounded-full ${style.bg} ${style.text}`}>
              {style.label}
            </span>
          </div>
        </div>
        {ev.detail && <p className="text-xs text-ink-muted mt-2">{ev.detail}</p>}

        {(ev.status === "needs_review" || ev.status === "pre_existing") &&
          (creatingNew[ev.id] ? (
            <div className="mt-3 rounded-md border border-dashed border-brand/40 bg-brand-tint/20 p-3">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-2 mb-2">
                <input
                  className="rounded-md border border-border-warm px-3 py-2 text-sm bg-white"
                  value={draftFor(ev).name}
                  onChange={(e) => setDraft(ev.id, { name: e.target.value })}
                  placeholder="Project name"
                  autoFocus
                />
                <select
                  className="rounded-md border border-border-warm px-3 py-2 text-sm bg-white"
                  value={draftFor(ev).topic_type}
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
                className="w-full rounded-md border border-border-warm px-3 py-2 text-sm bg-white mb-2"
                value={draftFor(ev).one_liner}
                onChange={(e) => setDraft(ev.id, { one_liner: e.target.value })}
                placeholder="One-line description (optional)"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleCreateNew(ev)}
                  disabled={!draftFor(ev).name.trim() || busy[ev.id]}
                  className="px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
                >
                  {busy[ev.id] ? "Creating…" : "Create project"}
                </button>
                <button
                  type="button"
                  onClick={() => setCreatingNew((c) => ({ ...c, [ev.id]: false }))}
                  className="px-3 py-1.5 text-xs font-medium rounded-md border border-border-warm text-ink-muted hover:bg-white"
                >
                  Cancel
                </button>
              </div>
              {ev.status === "pre_existing" && (
                <p className="text-[11px] text-ink-muted mt-2">
                  This recording hasn&apos;t been transcribed yet — creating a project will transcribe it now.
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <TopicAutocomplete
                topics={topics}
                value={assigning[ev.id] || ""}
                onChange={(id) => setAssigning({ ...assigning, [ev.id]: id })}
              />
              <button
                type="button"
                disabled={!assigning[ev.id] || busy[ev.id]}
                onClick={() => handleAssign(ev.id)}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
              >
                {busy[ev.id] ? "Assigning…" : "Assign"}
              </button>
              <span className="text-xs text-ink-muted">or</span>
              <button
                type="button"
                onClick={() => setCreatingNew((c) => ({ ...c, [ev.id]: true }))}
                className="text-xs font-medium text-teal-dark hover:underline"
              >
                + Create new project
              </button>
            </div>
          ))}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold text-[#1a1a1a] mb-1">Transcripts</h1>
      <p className="text-ink-muted text-sm mb-1">
        Recordings dropped into the shared Recordings folder are picked up automatically and
        transcribed, then grouped below by the project they belong to.
      </p>
      <p className="text-ink-muted text-sm mb-1">
        Configure the watched folder and transcription engine on the{" "}
        <Link href="/settings" className="text-teal-dark hover:underline">
          Settings page
        </Link>
        .
      </p>
      <p className="text-ink-muted text-sm mb-8">
        Looking for a file or folder you dragged in yourself? That lives on the{" "}
        <Link href="/home" className="text-teal-dark hover:underline">
          Dashboard
        </Link>{" "}
        instead — assign, create a project for, or dismiss it from there.
      </p>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {(pending.length > 0 || other.length > 0) && (
        <section className="mb-8">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted mb-3">
            New Transcripts Found ({pending.length + other.length})
          </h2>
          {/* Everything here just landed and hasn't been routed anywhere
              yet - whether the LLM has a guess about it (pending, shown
              first, richer treatment) or not (other, plain). One shared
              heading so there's a single place to check "is there anything
              new", instead of two differently-styled sections a person has
              to separately notice. */}
          <div className="flex flex-col gap-3 mb-3">
            {pending.map((ev) => {
              const draft = draftFor(ev);
              return (
                <div key={ev.id} className="rounded-lg border-2 border-dashed border-brand/40 bg-brand-tint/30 px-4 py-3.5">
                  <p className="text-xs font-medium text-ink-muted mb-2 truncate" title={ev.file_name}>
                    {ev.file_name} · {formatAdded(recordingDisplayDate(ev))}
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => handleConfirmNewProject(ev)}
                      disabled={!draft.name.trim() || busy[ev.id]}
                      className="px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
                    >
                      {busy[ev.id] ? "Creating…" : "Create project"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRejectNewProject(ev)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md border border-border-warm text-ink-muted hover:bg-white"
                    >
                      Not a new project
                    </button>
                  </div>

                  {/* Assigning directly to an existing project used to require
                      "Not a new project" first (demoting to needs_review) as a
                      detour - this makes it a first-class option right here,
                      since the LLM's own "new project" guess is a suggestion,
                      not the only path. */}
                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-brand/20 flex-wrap">
                    <span className="text-xs text-ink-muted">or assign to an existing project:</span>
                    <TopicAutocomplete
                      topics={topics}
                      value={assigning[ev.id] || ""}
                      onChange={(id) => setAssigning({ ...assigning, [ev.id]: id })}
                      placeholder="Choose a project…"
                    />
                    <button
                      type="button"
                      disabled={!assigning[ev.id] || busy[ev.id]}
                      onClick={() => handleAssign(ev.id)}
                      className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
                    >
                      {busy[ev.id] ? "Assigning…" : "Assign"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-col gap-2">{other.map((ev) => renderMeetingCard(ev))}</div>
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
                    <p className="text-xs text-ink-muted mt-0.5">{formatAdded(recordingDisplayDate(ev))}</p>
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

      {pending.length === 0 && other.length === 0 && preExisting.length === 0 && projectGroups.length === 0 && (
        <p className="text-sm text-ink-muted border border-dashed border-border-warm rounded-lg px-4 py-6 text-center">
          Nothing yet — new recordings dropped into the watched folder will show up here within about
          a minute.
        </p>
      )}

      {preExisting.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setShowPreExisting((v) => !v)}
            className="text-xs font-medium text-teal-dark hover:underline mb-3"
          >
            {showPreExisting ? "Hide" : "Show"} {preExisting.length} recording(s) from before auto-watch
            was turned on
          </button>
          {showPreExisting && <div className="flex flex-col gap-2">{preExisting.map((ev) => renderMeetingCard(ev))}</div>}
        </section>
      )}
    </div>
  );
}
