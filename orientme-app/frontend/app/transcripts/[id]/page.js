"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatAdded, recordingDisplayDate } from "../../lib/format";
import { STATUS_STYLES } from "../page";

// Same palette as the project page's stakeholder avatars - one colour per
// speaker, assigned in order of first appearance so it stays stable.
const SPEAKER_COLORS = ["#0096af", "#7c5cbf", "#d0811c", "#3a8f5f", "#c0517a", "#5a6b8c"];
const UNATTRIBUTED = "Unattributed";

// Consecutive turns by the same speaker read as one message - the backend
// splits a long run into several turns, which would otherwise repeat the
// name and avatar over and over.
function mergeTurns(turns) {
  const merged = [];
  for (const t of turns || []) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === t.speaker) {
      last.text = `${last.text}\n${t.text}`;
    } else {
      merged.push({ speaker: t.speaker, ts: t.ts, text: t.text });
    }
  }
  return merged;
}

// One recording's own detail page - the transcript text plus an on-demand
// summary panel. The summary is deliberately NEVER generated automatically
// on load; it only appears once a person clicks "Generate Summary" (see the
// backend's own RecordingEvent.meeting_summary docstring for why).
export default function TranscriptDetail({ params }) {
  const { id } = use(params);

  const [event, setEvent] = useState(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [generating, setGenerating] = useState(false);
  const [summaryError, setSummaryError] = useState(null);
  const [summaryNote, setSummaryNote] = useState(null); // the graceful no-key/failed-call message, when there is one

  const [diarizing, setDiarizing] = useState(false);
  const [diarizeError, setDiarizeError] = useState(null);
  const [diarizeNote, setDiarizeNote] = useState(null);

  const [generatingTranscript, setGeneratingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState(null);
  // "raw" | "speaker" | "conversation" - null until a person picks one, so the
  // default can follow whether speaker turns exist (Conversation) or not (Raw).
  const [transcriptView, setTranscriptView] = useState(null);

  const [renamingSpeaker, setRenamingSpeaker] = useState(false);
  const [renameOld, setRenameOld] = useState("");
  const [renameNew, setRenameNew] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [savedTo, setSavedTo] = useState(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    Promise.all([api.getRecordingEvent(id), api.getRecordingEventText(id)])
      .then(([ev, t]) => {
        setEvent(ev);
        setText(t.text || "");
      })
      .catch((e) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // The conversation is built in the background on first open (Whisper text
  // + an API key) - poll the detail endpoint every few seconds until it
  // finishes, then give up quietly after ~2 minutes rather than poll forever.
  const generatingConversation = !!event?.speaker_turns_generating;
  useEffect(() => {
    if (!generatingConversation) return;
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      try {
        const ev = await api.getRecordingEvent(id);
        setEvent(ev);
        if (!ev.speaker_turns_generating) clearInterval(timer);
      } catch (_) {}
      if (tries >= 40) clearInterval(timer);
    }, 3000);
    return () => clearInterval(timer);
  }, [generatingConversation, id]);

  async function handleRenameSpeaker(e) {
    e.preventDefault();
    const newName = renameNew.trim();
    if (!renameOld || !newName) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      const updated = await api.renameRecordingSpeaker(id, renameOld, newName);
      setEvent(updated);
      setRenamingSpeaker(false);
      setRenameNew("");
    } catch (err) {
      setRenameError(err.message);
    } finally {
      setRenameBusy(false);
    }
  }

  async function handleGenerateSummary() {
    setGenerating(true);
    setSummaryError(null);
    try {
      const updated = await api.generateRecordingSummary(id);
      setEvent(updated);
      setSummaryNote(updated.is_llm ? null : updated.message);
    } catch (e) {
      setSummaryError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  async function handleDiarize() {
    setDiarizing(true);
    setDiarizeError(null);
    setDiarizeNote(null);
    try {
      const updated = await api.diarizeRecording(id);
      setEvent(updated);
      if (!updated.succeeded) setDiarizeNote(updated.message);
    } catch (e) {
      setDiarizeError(e.message);
    } finally {
      setDiarizing(false);
    }
  }

  async function handleGenerateTranscript() {
    setGeneratingTranscript(true);
    setTranscriptError(null);
    try {
      const updated = await api.generateSpeakerTranscript(id);
      setEvent(updated);
      if (updated.succeeded) setTranscriptView("speaker");
      else setTranscriptError(updated.message);
    } catch (e) {
      setTranscriptError(e.message);
    } finally {
      setGeneratingTranscript(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSavedTo(null);
    try {
      const res = await api.saveRecordingSummary(id);
      setSavedTo(res.saved_to);
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="max-w-5xl mx-auto px-6 py-10 text-ink-muted text-sm">Loading…</div>;
  }

  if (loadError || !event) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-10">
        <p className="text-red-600 text-sm mb-3">{loadError || "Recording not found."}</p>
        <Link href="/transcripts" className="text-teal-dark text-sm hover:underline">
          ← Back to Transcripts
        </Link>
      </div>
    );
  }

  const style = STATUS_STYLES[event.status] || STATUS_STYLES.needs_review;

  const turns = Array.isArray(event.speaker_turns) ? event.speaker_turns : [];
  const hasTurns = turns.length > 0;
  const view = transcriptView || (hasTurns || generatingConversation ? "conversation" : "raw");
  const mergedTurns = mergeTurns(turns);
  // Legend: one entry per speaker (order of first appearance) with how many
  // chat turns they have as shown, so the counts match what's on screen.
  const speakerOrder = [];
  const speakerCounts = {};
  mergedTurns.forEach((t) => {
    if (!(t.speaker in speakerCounts)) {
      speakerCounts[t.speaker] = 0;
      speakerOrder.push(t.speaker);
    }
    speakerCounts[t.speaker] += 1;
  });
  const speakerColor = (name) =>
    name === UNATTRIBUTED ? "#9ca3af" : SPEAKER_COLORS[speakerOrder.indexOf(name) % SPEAKER_COLORS.length];
  const showToggle = !!event.speaker_transcript || hasTurns || generatingConversation;
  const source = event.speaker_turns_source;
  // Honest note for the one case where nothing smarter could happen: the
  // lines had no names and no API model was available to group them.
  const keyNote =
    event.llm_key_configured === false && (source === "code" || (!hasTurns && !!text))
      ? "No LLM API key is configured, so lines without speaker names can't be grouped by speaker. Add a key in Settings, then use Generate Transcript."
      : null;
  const callFailedNote =
    event.llm_key_configured && source === "code"
      ? "The API model did not return a usable result, so every line is grouped under one placeholder speaker. Check the key and model in Settings, then use Regenerate Transcript."
      : null;

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <Link href="/transcripts" className="text-sm text-teal-dark hover:underline">
        ← Back to Transcripts
      </Link>

      <div className="mt-3 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold text-[#1a1a1a] break-all">{event.file_name}</h1>
          <span className={`shrink-0 text-[11px] font-semibold px-2 py-1 rounded-full ${style.bg} ${style.text}`}>
            {style.label}
          </span>
        </div>
        <p className="text-sm text-ink-muted mt-1">
          Recorded {formatAdded(recordingDisplayDate(event))}
          {event.topic && (
            <>
              {" · "}
              <Link href={`/topics/${event.topic}`} className="text-teal-dark hover:underline">
                {event.topic_name}
              </Link>
            </>
          )}
        </p>
        {event.detail && <p className="text-sm text-ink-muted mt-1">{event.detail}</p>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Transcript */}
        <div className="rounded-lg border border-border-warm bg-white p-4">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Transcript</h2>
            <button
              type="button"
              onClick={handleGenerateTranscript}
              disabled={generatingTranscript}
              className="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-md border border-border-warm text-[#1a1a1a] hover:bg-brand-tint/30 disabled:opacity-40"
            >
              {generatingTranscript ? "Generating…" : event.speaker_transcript ? "Regenerate Transcript" : "Generate Transcript"}
            </button>
          </div>

          {transcriptError && <p className="text-red-600 text-xs mb-2">{transcriptError}</p>}

          {showToggle && (
            <div className="flex items-center gap-1 mb-2 text-xs">
              <button
                type="button"
                onClick={() => setTranscriptView("raw")}
                className={`px-2.5 py-1 rounded-full font-medium ${
                  view === "raw" ? "bg-teal-tint text-teal-dark" : "text-ink-muted hover:bg-cream"
                }`}
              >
                Raw
              </button>
              {event.speaker_transcript && (
                <button
                  type="button"
                  onClick={() => setTranscriptView("speaker")}
                  className={`px-2.5 py-1 rounded-full font-medium ${
                    view === "speaker" ? "bg-teal-tint text-teal-dark" : "text-ink-muted hover:bg-cream"
                  }`}
                >
                  By Speaker
                </button>
              )}
              {(hasTurns || generatingConversation) && (
                <button
                  type="button"
                  onClick={() => setTranscriptView("conversation")}
                  className={`px-2.5 py-1 rounded-full font-medium ${
                    view === "conversation" ? "bg-teal-tint text-teal-dark" : "text-ink-muted hover:bg-cream"
                  }`}
                >
                  Conversation
                </button>
              )}
            </div>
          )}

          {(keyNote || callFailedNote) && (
            <p className="text-xs mb-2 rounded-md px-2.5 py-1.5 bg-[#f3f2ec] text-ink-muted">{keyNote || callFailedNote}</p>
          )}

          {view === "conversation" ? (
            <div data-testid="conversation-view">
              {generatingConversation && !hasTurns ? (
                <div className="rounded-md bg-[#faf9f5] border border-border-warm px-3 py-6 text-sm text-ink-muted text-center">
                  Generating conversation…
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 flex-wrap mb-2" data-testid="speaker-legend">
                    {speakerOrder.map((name) => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1.5 text-[11px] text-[#1a1a1a] rounded-full border border-border-warm px-2 py-0.5"
                      >
                        <span className="w-2 h-2 rounded-full" style={{ background: speakerColor(name) }} />
                        {name}
                        <span className="text-ink-muted">
                          · {speakerCounts[name]} turn{speakerCounts[name] === 1 ? "" : "s"}
                        </span>
                      </span>
                    ))}
                    {!renamingSpeaker && (
                      <button
                        type="button"
                        onClick={() => {
                          setRenameOld(speakerOrder[0] || "");
                          setRenameNew("");
                          setRenameError(null);
                          setRenamingSpeaker(true);
                        }}
                        className="text-[11px] font-medium text-teal-dark hover:underline"
                      >
                        Rename speaker
                      </button>
                    )}
                  </div>

                  {renamingSpeaker && (
                    <form onSubmit={handleRenameSpeaker} className="flex items-center gap-1.5 flex-wrap mb-2">
                      <select
                        value={renameOld}
                        onChange={(e) => setRenameOld(e.target.value)}
                        aria-label="Speaker to rename"
                        className="text-xs rounded-md border border-border-warm bg-white px-2 py-1"
                      >
                        {speakerOrder.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <span className="text-xs text-ink-muted">→</span>
                      <input
                        value={renameNew}
                        onChange={(e) => setRenameNew(e.target.value)}
                        maxLength={60}
                        autoFocus
                        placeholder="Real name"
                        aria-label="New speaker name"
                        className="text-xs rounded-md border border-border-warm px-2 py-1 w-40"
                      />
                      <button
                        type="submit"
                        disabled={renameBusy || !renameNew.trim()}
                        className="px-2.5 py-1 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
                      >
                        {renameBusy ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenamingSpeaker(false)}
                        className="text-xs font-medium text-ink-muted hover:text-[#1a1a1a]"
                      >
                        Cancel
                      </button>
                      {renameError && <p className="w-full text-red-600 text-xs">{renameError}</p>}
                    </form>
                  )}

                  <div className="space-y-3 max-h-[70vh] overflow-y-auto rounded-md bg-[#faf9f5] border border-border-warm px-3 py-3">
                    {mergedTurns.map((t, i) => (
                      <div key={i} className="flex gap-2.5" data-testid="conversation-turn">
                        <span
                          className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                          style={{ background: speakerColor(t.speaker) }}
                        >
                          {(t.speaker || "?").trim()[0]?.toUpperCase() || "?"}
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-[#1a1a1a]">
                            {t.speaker}
                            {t.ts && <span className="ml-2 font-normal text-ink-muted">{t.ts}</span>}
                          </p>
                          <p className="text-sm text-[#1a1a1a] leading-relaxed whitespace-pre-wrap">{t.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  {generatingConversation && (
                    <p className="text-[11px] text-ink-muted mt-2">Generating conversation…</p>
                  )}
                  <p className="text-[11px] text-ink-muted mt-2">
                    {source === "teams"
                      ? "Speaker names were read straight from the transcript - no model was used."
                      : source === "llm"
                        ? "Speakers were grouped by the configured API model from the transcript lines; every word and timestamp is from the transcript itself, not generated. Rename a speaker if the label is wrong."
                        : "Speaker labels here are a best-effort grouping, not verified audio-based diarization. Rename a speaker if the label is wrong."}
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="whitespace-pre-wrap font-mono text-xs text-[#1a1a1a] leading-relaxed max-h-[70vh] overflow-y-auto rounded-md bg-[#faf9f5] border border-border-warm px-3 py-3">
              {view === "speaker" && event.speaker_transcript
                ? event.speaker_transcript
                : text || "(no transcript text available)"}
            </div>
          )}
          {view === "speaker" && event.speaker_transcript_generated_at && (
            <p className="text-[11px] text-ink-muted mt-2">
              Generated {formatAdded(event.speaker_transcript_generated_at)} · speaker labels are the
              local model&apos;s best-effort read of who&apos;s speaking, not verified audio-based
              diarization
            </p>
          )}
        </div>

        {/* Summary - never generated automatically, only on this click. */}
        <div className="rounded-lg border border-border-warm bg-white p-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted mb-3">Summary</h2>

          {summaryError && <p className="text-red-600 text-xs mb-2">{summaryError}</p>}
          {summaryNote && <p className="text-xs text-ink-muted mb-2">{summaryNote}</p>}

          {!event.meeting_summary ? (
            <>
              <p className="text-sm text-ink-muted mb-3">No summary yet.</p>
              <button
                type="button"
                onClick={handleGenerateSummary}
                disabled={generating}
                className="px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
              >
                {generating ? "Generating…" : "Generate Summary"}
              </button>
            </>
          ) : (
            <>
              <div className="whitespace-pre-wrap text-sm text-[#1a1a1a] leading-relaxed mb-3 max-h-[55vh] overflow-y-auto">
                {event.meeting_summary}
              </div>
              {event.summary_generated_at && (
                <p className="text-[11px] text-ink-muted mb-3">
                  Generated {formatAdded(event.summary_generated_at)}
                </p>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={handleGenerateSummary}
                  disabled={generating}
                  className="px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
                >
                  {generating ? "Generating…" : "Regenerate"}
                </button>
                {event.topic && (
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md border border-border-warm text-[#1a1a1a] hover:bg-brand-tint/30 disabled:opacity-40"
                  >
                    {saving ? "Saving…" : "Save to project folder"}
                  </button>
                )}
              </div>
              {saveError && <p className="text-red-600 text-xs mt-2">{saveError}</p>}
              {savedTo && <p className="text-teal-dark text-xs mt-2">Saved to {savedTo}</p>}
            </>
          )}
        </div>
      </div>

      {/* Diarize - a structured participants/decisions/action-items/
          parked-items/per-speaker breakdown, matching the shape of the
          reference example Ayush uploaded (30 Sep) - a local-only LLM call
          (core/local_llm.py), never the raw transcript being sent anywhere
          external. Deliberately its own full-width section, separate from
          the plain code-based Summary above. */}
      <div className="rounded-lg border border-border-warm bg-white p-4 mt-6">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Diarize</h2>
          <button
            type="button"
            onClick={handleDiarize}
            disabled={diarizing}
            className="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
          >
            {diarizing ? "Diarizing…" : event.diarization_result ? "Regenerate" : "Diarize"}
          </button>
        </div>

        {diarizeError && <p className="text-red-600 text-xs mb-2">{diarizeError}</p>}
        {diarizeNote && <p className="text-xs mb-2 rounded-md px-2.5 py-1.5 bg-[#f3f2ec] text-ink-muted">{diarizeNote}</p>}

        {event.diarization_result ? (
          <>
            <div className="whitespace-pre-wrap text-sm text-[#1a1a1a] leading-relaxed max-h-[70vh] overflow-y-auto">
              {event.diarization_result}
            </div>
            {event.diarization_generated_at && (
              <p className="text-[11px] text-ink-muted mt-3">
                Generated {formatAdded(event.diarization_generated_at)} — participants and per-speaker
                attribution come from the model reading the transcript text itself, not real
                audio-based speaker diarization
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-muted">
            No breakdown yet — click Diarize to get participants, decisions, action items, parked
            items and a per-speaker summary from this transcript.
          </p>
        )}
      </div>
    </div>
  );
}
