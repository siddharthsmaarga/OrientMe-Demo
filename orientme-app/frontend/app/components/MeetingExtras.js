"use client";

import { useState } from "react";
import { api } from "../lib/api";

const MEETING_TYPE_OPTIONS = [
  { key: "intro", label: "Intro" },
  { key: "discovery", label: "Discovery" },
  { key: "solution", label: "Solution" },
  { key: "commercial", label: "Commercial" },
  { key: "kickoff", label: "Kickoff" },
  { key: "review", label: "Review" },
  { key: "standup", label: "Stand-up" },
  { key: "other", label: "Other" },
];

// Meeting type + sequence ("Discovery 2"), auto-detected from the title but
// editable. Saving marks it as set by a person, so a later re-scan never
// overwrites it.
export function MeetingTypeEditor({ entry, onChanged }) {
  const [type, setType] = useState(entry.meeting_type || "");
  const [seq, setSeq] = useState(entry.meeting_sequence ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const dirty = type !== (entry.meeting_type || "") || String(seq) !== String(entry.meeting_sequence ?? "");

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      await api.updateMeeting(entry.id, {
        meeting_type: type,
        meeting_sequence: seq === "" ? null : Number(seq),
      });
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2" data-testid="meeting-type-editor">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          aria-label="Meeting type"
          className="text-[11px] rounded border border-slate-300 bg-white px-1.5 py-0.5"
        >
          <option value="">Meeting type: not set</option>
          {MEETING_TYPE_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          max={99}
          value={seq}
          onChange={(e) => setSeq(e.target.value)}
          placeholder="#"
          aria-label="Meeting sequence number"
          className="w-14 text-[11px] rounded border border-slate-300 px-1.5 py-0.5"
        />
        {dirty && (
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className="text-[11px] font-medium text-white bg-brand rounded px-2 py-0.5 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      {error && <p className="text-[11px] text-red-600 mt-1 break-words">{error}</p>}
    </div>
  );
}

// "Who said what" - per-speaker turns/words and the first few substantive
// lines, read from the transcript text in plain code (no model, no guessing).
// Only rendered when the transcript actually had speaker names.
export function WhoSaidWhat({ entry }) {
  const summary = Array.isArray(entry.speaker_summary) ? entry.speaker_summary : [];
  if (summary.length === 0) return null;

  return (
    <details className="mt-2 rounded-md border border-slate-100 bg-slate-50/60 px-2 py-1.5" data-testid="who-said-what">
      <summary className="cursor-pointer text-[11px] font-medium text-slate-600 hover:text-slate-800">
        Who said what
      </summary>
      <div className="mt-1.5 space-y-2">
        {summary.map((s) => (
          <div key={s.speaker}>
            <p className="text-[11px] font-semibold text-slate-700">
              {s.speaker}
              <span className="font-normal text-slate-400">
                {" "}
                · {s.turns} turn{s.turns === 1 ? "" : "s"} · {s.words} words
              </span>
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {(s.first_lines || []).map((line, i) => (
                <li key={i} className="text-[11px] text-slate-600 flex gap-1">
                  <span className="text-slate-300 shrink-0">•</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}

// "+ Add note after this meeting" - the one or two lines a person writes
// right after a call. Notes are trusted evidence for the brief and show on
// the timeline; existing ones are listed under the box.
export function MeetingNotes({ topicId, entry, onChanged }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const notes = Array.isArray(entry.notes) ? entry.notes : [];

  async function handleAdd(e) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addNote(topicId, text.trim(), entry.id);
      setText("");
      setOpen(false);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(noteId) {
    try {
      await api.deleteNote(topicId, noteId);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="mt-2" data-testid="meeting-notes">
      {notes.length > 0 && (
        <ul className="space-y-1 mb-1.5">
          {notes.map((n) => (
            <li key={n.id} className="text-[11px] text-slate-600 bg-amber-50/70 border border-amber-100 rounded px-2 py-1">
              <span className="whitespace-pre-wrap">{n.text}</span>
              <span className="block text-[10px] text-slate-400 mt-0.5">
                {n.author}
                {n.created_at ? ` · ${new Date(n.created_at).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}` : ""}
                {" · "}
                <button
                  type="button"
                  onClick={() => handleDelete(n.id)}
                  className="text-slate-400 hover:text-red-600 hover:underline"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <form onSubmit={handleAdd} className="space-y-1.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            maxLength={2000}
            autoFocus
            placeholder="One or two lines - what happened, what matters"
            aria-label="Note after this meeting"
            className="w-full rounded border border-slate-300 px-2 py-1 text-[11px] resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || !text.trim()}
              className="text-[11px] font-medium text-white bg-brand rounded px-2 py-1 disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save note"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setText("");
              }}
              className="text-[11px] font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[11px] font-medium text-teal-dark hover:underline"
        >
          + Add note after this meeting
        </button>
      )}
      {error && <p className="text-[11px] text-red-600 mt-1 break-words">{error}</p>}
    </div>
  );
}
