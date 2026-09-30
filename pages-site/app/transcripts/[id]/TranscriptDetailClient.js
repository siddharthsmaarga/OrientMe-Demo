"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatAdded, recordingDisplayDate } from "../../lib/format";
import { STATUS_STYLES } from "../page";

// Detail view for one Transcripts row (see ../page.js). Two-column layout:
// Transcript (raw text, with an on-demand "Generate Transcript" speaker
// split) + the honest empty-state / generated-summary Summary panel below
// it - the Summary panel's own logic is untouched here (see api.js's
// buildMeetingSummary; it's never generated automatically, only on a
// click). A third, full-width Diarize section sits below the two-column
// grid - a separate structured participants/decisions/action-items/
// parked-items/per-speaker breakdown, matching the real app's own layout.
// Neither Generate Transcript nor Diarize call a real model in this static
// demo - both just reveal a pre-baked fixture (fixtures.js's
// speaker_transcript / diarization_result) when one exists for this
// recording, and show an honest not-available message otherwise (see
// api.js's generateSpeakerTranscript / diarizeRecording).
export default function TranscriptDetailClient({ id }) {
  const [event, setEvent] = useState(null);
  const [text, setText] = useState("");
  const [loadError, setLoadError] = useState(null);

  const [generating, setGenerating] = useState(false);
  const [summaryError, setSummaryError] = useState(null);

  const [generatingTranscript, setGeneratingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState(null);
  const [transcriptView, setTranscriptView] = useState("raw"); // "raw" | "speaker"

  const [diarizing, setDiarizing] = useState(false);
  const [diarizeError, setDiarizeError] = useState(null);
  const [diarizeNote, setDiarizeNote] = useState(null);

  const [saveState, setSaveState] = useState("idle"); // idle | loading | done | error
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [ev, textResult] = await Promise.all([api.getRecordingEvent(id), api.getRecordingEventText(id)]);
        if (cancelled) return;
        setEvent(ev);
        setText(textResult.text || "");
      } catch (e) {
        if (!cancelled) setLoadError(e.message);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function handleGenerateSummary() {
    setGenerating(true);
    setSummaryError(null);
    setSaveState("idle");
    setSaveError(null);
    try {
      const updated = await api.generateRecordingSummary(id);
      setEvent(updated);
    } catch (e) {
      setSummaryError(e.message);
    } finally {
      setGenerating(false);
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

  async function handleSave() {
    setSaveState("loading");
    setSaveError(null);
    try {
      await api.saveRecordingSummary(id);
      setSaveState("done");
    } catch (e) {
      setSaveError(e.message);
      setSaveState("error");
    }
  }

  if (loadError) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-10">
        <Link href="/transcripts" className="text-sm text-teal-dark hover:underline mb-4 inline-block">
          ← Back to Transcripts
        </Link>
        <div className="rounded-md bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">{loadError}</div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-10">
        <p className="text-ink-muted text-sm">Loading…</p>
      </div>
    );
  }

  const style = STATUS_STYLES[event.status] || STATUS_STYLES.needs_review;

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <Link href="/transcripts" className="text-sm text-teal-dark hover:underline mb-4 inline-block">
        ← Back to Transcripts
      </Link>

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-[#1a1a1a] mb-1 break-all">{event.file_name}</h1>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span>{formatAdded(recordingDisplayDate(event))}</span>
          <span className={`text-[11px] font-semibold px-2 py-1 rounded-full ${style.bg} ${style.text}`}>{style.label}</span>
          {event.source === "manual_drop" && (
            <span className="text-[11px] font-semibold px-2 py-1 rounded-full bg-[#f3f2ec] text-ink-muted">
              Manually dropped
            </span>
          )}
          {event.topic && (
            <Link href={`/topics/?id=${encodeURIComponent(event.topic)}`} className="text-teal-dark hover:underline">
              {event.topic_name || "View project"} →
            </Link>
          )}
        </div>
        {event.detail && <p className="text-xs text-ink-muted mt-2">{event.detail}</p>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
        <section className="rounded-lg border border-border-warm bg-white p-5">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Transcript</h2>
            <button
              type="button"
              onClick={handleGenerateTranscript}
              disabled={generatingTranscript}
              className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-md border border-border-warm text-ink-muted hover:bg-cream disabled:opacity-50"
            >
              {generatingTranscript ? "Generating…" : event.speaker_transcript ? "Regenerate Transcript" : "Generate Transcript"}
            </button>
          </div>

          {transcriptError && (
            <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">{transcriptError}</div>
          )}

          {event.speaker_transcript && (
            <div className="flex items-center gap-1 mb-3 text-xs">
              <button
                type="button"
                onClick={() => setTranscriptView("raw")}
                className={`px-2.5 py-1 rounded-full font-medium ${
                  transcriptView === "raw" ? "bg-teal-tint text-teal-dark" : "text-ink-muted hover:bg-cream"
                }`}
              >
                Raw
              </button>
              <button
                type="button"
                onClick={() => setTranscriptView("speaker")}
                className={`px-2.5 py-1 rounded-full font-medium ${
                  transcriptView === "speaker" ? "bg-teal-tint text-teal-dark" : "text-ink-muted hover:bg-cream"
                }`}
              >
                By Speaker
              </button>
            </div>
          )}

          {(transcriptView === "speaker" && event.speaker_transcript ? event.speaker_transcript : text) ? (
            <div className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap font-mono text-xs text-[#1a1a1a] leading-relaxed rounded-md bg-[#faf9f5] border border-border-warm px-3 py-3">
              {transcriptView === "speaker" && event.speaker_transcript ? event.speaker_transcript : text}
            </div>
          ) : (
            <p className="text-sm text-ink-muted border border-dashed border-border-warm rounded-lg px-4 py-6 text-center">
              No transcript text captured for this recording in this demo.
            </p>
          )}
          {transcriptView === "speaker" && event.speaker_transcript_generated_at && (
            <p className="text-[11px] text-ink-muted mt-2">
              Generated {formatAdded(event.speaker_transcript_generated_at)} · speaker labels are a
              best-effort read of who&apos;s speaking, not verified audio-based diarization
            </p>
          )}
        </section>

        <section className="rounded-lg border border-border-warm bg-white p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted mb-3">Summary</h2>

          {summaryError && (
            <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">{summaryError}</div>
          )}

          {generating && (
            <div className="mb-3 rounded-md bg-teal-tint border border-teal-tint-strong text-teal-dark text-xs px-3 py-2">
              Generating…
            </div>
          )}

          {event.meeting_summary ? (
            <>
              <p className="text-sm text-[#1a1a1a] whitespace-pre-wrap leading-relaxed mb-3">{event.meeting_summary}</p>
              <p className="text-xs text-ink-muted bg-[#f3f2ec] border border-border-warm rounded px-3 py-2 mb-3">
                Built from this transcript by plain extractive scoring (which words repeat most, which lines carry
                them) — deterministic code, not a model call.
              </p>
              {event.summary_generated_at && (
                <p className="text-xs text-ink-muted mb-4">Generated {formatAdded(event.summary_generated_at)}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleGenerateSummary}
                  disabled={generating || !text}
                  className="px-3 py-1.5 text-xs font-medium rounded-md border border-border-warm text-ink-muted hover:bg-cream disabled:opacity-50"
                >
                  {generating ? "Regenerating…" : "Regenerate"}
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saveState === "loading"}
                  className="px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
                >
                  {saveState === "loading" ? "Saving…" : saveState === "done" ? "Saved ✓" : "Save"}
                </button>
              </div>
              {saveError && <p className="text-xs text-red-600 mt-2">{saveError}</p>}
              <p className="text-[11px] text-ink-muted mt-2">
                Saved to this browser session only (fixture demo data) — resets on refresh, same as every other edit
                in this demo.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-ink-muted border border-dashed border-border-warm rounded-lg px-4 py-6 text-center mb-3">
                No summary yet — generate one from the transcript on the left.
              </p>
              <button
                type="button"
                onClick={handleGenerateSummary}
                disabled={generating || !text}
                className="px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
              >
                {generating ? "Generating…" : "Generate Summary"}
              </button>
              {!text && (
                <p className="text-xs text-ink-muted mt-2">
                  No transcript text captured for this recording, so there&apos;s nothing to summarize.
                </p>
              )}
            </>
          )}
        </section>
      </div>

      {/* Diarize - a structured participants/decisions/action-items/
          parked-items/per-speaker breakdown, matching the real app's own
          shape (core/recordings.py's _render_diarization_markdown). Its own
          full-width section, separate from the plain code-based Summary
          above. */}
      <div className="rounded-lg border border-border-warm bg-white p-5 mt-6">
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

        {diarizeError && (
          <div className="mb-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2">{diarizeError}</div>
        )}
        {diarizeNote && (
          <p className="text-xs mb-3 rounded-md px-2.5 py-1.5 bg-[#f3f2ec] text-ink-muted">{diarizeNote}</p>
        )}

        {event.diarization_result ? (
          <>
            <div className="whitespace-pre-wrap text-sm text-[#1a1a1a] leading-relaxed max-h-[70vh] overflow-y-auto">
              {event.diarization_result}
            </div>
            {event.diarization_generated_at && (
              <p className="text-[11px] text-ink-muted mt-3">
                Generated {formatAdded(event.diarization_generated_at)} — participants and per-speaker
                attribution come from reading the transcript text itself, not real audio-based speaker
                diarization
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-muted">
            No breakdown yet — click Diarize to get participants, decisions, action items, parked items
            and a per-speaker summary from this transcript.
          </p>
        )}
      </div>
    </div>
  );
}
