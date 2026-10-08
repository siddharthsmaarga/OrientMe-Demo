"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { openSourceFile } from "../lib/demoFiles";
import { formatMeetingDate } from "../lib/format";

// "Where did this action item come from?" - opened by clicking the item.
// Shows the file the item was pulled from - its template/type name first
// (e.g. "Meeting Transcript"), the real file name second - and the passage of
// that file closest to the item's wording.
//
// The passage is the nearest match found in the file's own text, not a stored
// quote: the item was rewritten into a short task when it was extracted, so
// the panel says so instead of presenting it as word-for-word. When nothing in
// the file matches well enough it shows only the file, never a guess.
export default function TaskSourcePanel({ taskId }) {
  const [source, setSource] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getTaskSource(taskId)
      .then((data) => !cancelled && setSource(data))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const shell = "mt-1 mb-2 ml-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600";

  if (error) return <div className={`${shell} text-red-600`}>Could not load the source: {error}</div>;
  if (!source) return <div className={`${shell} text-slate-400`}>Loading source…</div>;
  if (source.added_by_hand) {
    return <div className={shell}>Added by hand — it was not pulled from a file.</div>;
  }

  const { file, passage } = source;
  const sameName = file.label === file.name;
  return (
    <div className={shell}>
      <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">From</span>
        <span className="font-semibold text-slate-800">{file.label}</span>
        {!sameName && <span className="text-slate-400 truncate max-w-[18rem]" title={file.name}>{file.name}</span>}
        {file.date && <span className="text-slate-400">· {formatMeetingDate(file.date)}</span>}
        {file.read_by_ai && (
          <span
            className="px-1.5 py-0.5 rounded-full bg-brand-tint text-brand text-[10px] font-medium"
            title="The file name did not say what this document is, so OrientMe read its content to decide."
          >
            Read by AI
          </span>
        )}
        {file.openable && (
          <button
            type="button"
            onClick={() => openSourceFile(file)}
            className="ml-auto text-brand hover:underline whitespace-nowrap"
          >
            Open file ↗
          </button>
        )}
      </div>

      {passage ? (
        <div className="mt-2">
          {passage.before && <p className="text-slate-400 leading-snug mb-1">…{passage.before}</p>}
          <blockquote className="border-l-2 border-teal pl-2.5 text-slate-800 leading-snug">
            {(passage.speaker || passage.ts) && (
              <span className="block text-[11px] font-semibold text-teal-dark mb-0.5">
                {[passage.speaker, passage.ts].filter(Boolean).join(" · ")}
              </span>
            )}
            {passage.text}
          </blockquote>
          {passage.after && <p className="text-slate-400 leading-snug mt-1">{passage.after}…</p>}
          <p className="mt-1.5 text-[11px] text-slate-400">
            Closest match in the file — the action item was reworded, so this is the nearest passage, not a
            word-for-word quote.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-slate-500">
          No single passage matches the wording closely enough to show. Open the file to check.
        </p>
      )}
    </div>
  );
}
