"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatAdded } from "../../lib/format";
import { STATUS_STYLES } from "../page";

// Detail view for one Transcripts row (see ../page.js). Two-column layout:
// full transcript + honest "Diarize" button on the left, an empty-state /
// generated-summary panel on the right. The summary is never generated
// automatically - only api.generateRecordingSummary() (deterministic code,
// not a model call - see api.js's buildMeetingSummary) writes it, and only
// when a person clicks the button.
export default function TranscriptDetailClient({ id }) {
  const [event, setEvent] = useState(null);
  const [text, setText] = useState("");
  const [loadError, setLoadError] = useState(null);

  const [generating, setGenerating] = useState(false);
  const [summaryError, setSummaryError] = useState(null);

  const [diarizing, setDiarizing] = useState(false);
  const [diarizeResult, setDiarizeResult] = useState(null);

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

  async function handleDiarize() {
    setDiarizing(true);
    try {
      const result = await api.diarizeRecording(id);
      setDiarizeResult(result);
    } catch (e) {
      setDiarizeResult({ message: e.message });
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
          <span>{formatAdded(event.detected_at)}</span>
          <span className={`text-[11px] font-semibold px-2 py-1 rounded-full ${style.bg} ${style.text}`}>{style.label}</span>
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
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Transcript</h2>
            <button
              type="button"
              onClick={handleDiarize}
              disabled={diarizing}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-border-warm text-ink-muted hover:bg-cream disabled:opacity-50"
            >
              {diarizing ? "Checking…" : "Diarize"}
            </button>
          </div>

          {diarizeResult && (
            <div className="mb-3 rounded-md bg-[#f3f2ec] border border-border-warm text-ink-muted text-xs px-3 py-2">
              {diarizeResult.message}
            </div>
          )}

          {text ? (
            <div className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap text-sm text-[#1a1a1a] leading-relaxed">
              {text}
            </div>
          ) : (
            <p className="text-sm text-ink-muted border border-dashed border-border-warm rounded-lg px-4 py-6 text-center">
              No transcript text captured for this recording in this demo.
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
    </div>
  );
}
