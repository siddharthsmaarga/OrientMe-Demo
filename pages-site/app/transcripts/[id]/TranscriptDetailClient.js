"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatAdded, recordingDisplayDate } from "../../lib/format";
import { STATUS_STYLES } from "../page";

// One recording's own detail page - the transcript text plus an on-demand
// summary panel. The summary is deliberately NEVER generated automatically
// on load; it only appears once a person clicks "Generate Summary" (see
// api.js's buildMeetingSummary - deterministic code, not a model call).
// Generate Transcript / Diarize reveal pre-baked fixture output when one
// exists for this recording (this static demo has no model behind them) and
// show an honest not-available message otherwise.
export default function TranscriptDetailClient({ id }) {
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
  const [transcriptView, setTranscriptView] = useState("raw"); // "raw" | "speaker"

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
              <Link href={`/topics/?id=${encodeURIComponent(event.topic)}`} className="text-teal-dark hover:underline">
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

          {event.speaker_transcript && (
            <div className="flex items-center gap-1 mb-2 text-xs">
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

          <div className="whitespace-pre-wrap font-mono text-xs text-[#1a1a1a] leading-relaxed max-h-[70vh] overflow-y-auto rounded-md bg-[#faf9f5] border border-border-warm px-3 py-3">
            {transcriptView === "speaker" && event.speaker_transcript
              ? event.speaker_transcript
              : text || "(no transcript text available)"}
          </div>
          {transcriptView === "speaker" && event.speaker_transcript_generated_at && (
            <p className="text-[11px] text-ink-muted mt-2">
              Generated {formatAdded(event.speaker_transcript_generated_at)} · speaker labels are a
              best-effort read of who&apos;s speaking, not verified audio-based
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
          supplied reference example (30 Sep) - a local-only LLM call
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
                attribution come from reading the transcript text itself, not real
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
