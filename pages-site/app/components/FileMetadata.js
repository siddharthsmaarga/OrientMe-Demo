"use client";

import { useState } from "react";
import { api } from "../lib/api";

// Document-type vocabulary - keys/labels match the backend's own choices
// (core/models.py IngestedFile.doc_type), also what the metadata CSV uses.
export const DOC_TYPE_OPTIONS = [
  { key: "email", label: "Email" },
  { key: "meeting_transcript", label: "Meeting Transcript" },
  { key: "mom_action_items", label: "MoM / Action Items" },
  { key: "proposal", label: "Proposal" },
  { key: "quotation_sow", label: "Quotation / SOW" },
  { key: "prd_brd", label: "PRD / BRD" },
  { key: "project_charter", label: "Project Charter" },
  { key: "project_plan", label: "Project Plan" },
  { key: "stakeholder_map", label: "Stakeholder Map" },
  { key: "report", label: "Report" },
  { key: "notes", label: "Notes" },
  { key: "other", label: "Other" },
];

// Suggested tag vocabulary - free text is still allowed (max 3 per file).
const TAG_SUGGESTIONS = [
  "Relationship",
  "Requirements",
  "Solution",
  "Commercial",
  "Timeline",
  "Stakeholders",
  "Risks",
  "Next Steps",
  "Decisions",
];

const STATE_CHIPS = {
  generated_unconfirmed: { label: "Generated", cls: "bg-slate-100 text-slate-600" },
  confirmed: { label: "Confirmed", cls: "bg-emerald-50 text-emerald-700" },
  corrected: { label: "Corrected", cls: "bg-amber-50 text-amber-700" },
  error: { label: "Error", cls: "bg-red-50 text-red-700" },
};

// The auto-filled metadata for one ingested file (type, version, tags, one
// signal line) plus the human's say over it: Confirm it as-is, or edit details + a review note. Nothing here
// replaces an existing file-list column - it only sits underneath them.
// `file` is an IngestedFile as returned by the topic detail or the global
// sources endpoint (both carry the same metadata keys); onChanged receives
// (fileId, updatedMetadata) so the parent can refresh its own copy.
export default function FileMetadata({ file, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);

  const state = STATE_CHIPS[file.meta_state];
  const tags = file.topic_tag_list || [];

  async function save(fields) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateFileMetadata(file.id, fields);
      onChanged?.(file.id, updated);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.confirmFileMetadata(file.id);
      onChanged?.(file.id, updated);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function startEditing() {
    setForm({
      doc_type: file.doc_type || "",
      version_label: file.version_label || "",
      topic_tags: tags.join(", "),
      signal: file.signal || "",
      document_date: file.document_date || "",
      review_notes: file.review_notes || "",
    });
    setEditing(true);
  }

  async function handleSaveForm(e) {
    e.preventDefault();
    // Only send what actually changed - a review-note-only edit must not
    // flip the file to "Corrected" (the backend keys off which fields arrive).
    const newTags = form.topic_tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const fields = {};
    if (form.doc_type && form.doc_type !== (file.doc_type || "")) fields.doc_type = form.doc_type;
    if (newTags.join(", ") !== tags.join(", ")) fields.topic_tags = newTags;
    if (form.signal !== (file.signal || "")) fields.signal = form.signal;
    if (form.version_label !== (file.version_label || "")) fields.version_label = form.version_label;
    if (form.document_date !== (file.document_date || "")) fields.document_date = form.document_date || null;
    if (form.review_notes !== (file.review_notes || "")) fields.review_notes = form.review_notes;
    if (Object.keys(fields).length === 0) {
      setEditing(false);
      return;
    }
    if (await save(fields)) setEditing(false);
  }

  return (
    <div className="mt-1.5 space-y-1" data-testid="file-metadata">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          title="Document type - detected automatically from the file; use Edit details only if it is wrong"
          data-testid="doc-type-chip"
          className="text-[10px] font-medium rounded-full border border-teal-tint-strong bg-teal-tint text-teal-dark px-1.5 py-0.5"
        >
          {(DOC_TYPE_OPTIONS.find((o) => o.key === file.doc_type) || {}).label || "Type: not set"}
        </span>
        {file.version_label && (
          <span className="text-[10px] font-semibold text-violet-700 bg-violet-50 px-1.5 py-0.5 rounded-full">
            {file.version_label}
          </span>
        )}
        {tags.map((t) => (
          <span key={t} className="text-[10px] text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded-full">
            {t}
          </span>
        ))}
        {state && (
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${state.cls}`}>{state.label}</span>
        )}
      </div>

      {file.signal && <p className="text-[11px] text-slate-500 leading-snug">{file.signal}</p>}
      {file.review_notes && (
        <p className="text-[11px] text-slate-500 italic leading-snug">Review note: {file.review_notes}</p>
      )}

      {!editing && (
        <div className="flex items-center gap-3">
          {(file.meta_state === "generated_unconfirmed" || !file.meta_state) && file.doc_type && (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={busy}
              className="text-[11px] font-medium text-teal-dark hover:underline disabled:opacity-40"
            >
              Confirm
            </button>
          )}
          <button
            type="button"
            onClick={startEditing}
            className="text-[11px] font-medium text-slate-500 hover:text-slate-700 hover:underline"
          >
            Edit details
          </button>
        </div>
      )}

      {editing && form && (
        <form onSubmit={handleSaveForm} className="rounded-md border border-slate-200 bg-slate-50/60 p-2 space-y-1.5">
          <select
            value={form.doc_type}
            onChange={(e) => setForm({ ...form, doc_type: e.target.value })}
            aria-label="Document type (only change if the automatic one is wrong)"
            className="w-full rounded border border-slate-300 px-1.5 py-1 text-[11px]"
          >
            {!form.doc_type && <option value="">Type: not set</option>}
            {DOC_TYPE_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <input
              value={form.version_label}
              onChange={(e) => setForm({ ...form, version_label: e.target.value })}
              placeholder="Version (V1, V2, Final)"
              aria-label="Version label"
              className="w-1/2 rounded border border-slate-300 px-1.5 py-1 text-[11px]"
            />
            <input
              type="date"
              value={form.document_date}
              onChange={(e) => setForm({ ...form, document_date: e.target.value })}
              aria-label="Document date"
              className="w-1/2 rounded border border-slate-300 px-1.5 py-1 text-[11px]"
            />
          </div>
          <input
            value={form.topic_tags}
            onChange={(e) => setForm({ ...form, topic_tags: e.target.value })}
            placeholder="Topic tags, comma separated (max 3)"
            aria-label="Topic tags"
            list="file-tag-suggestions"
            className="w-full rounded border border-slate-300 px-1.5 py-1 text-[11px]"
          />
          <datalist id="file-tag-suggestions">
            {TAG_SUGGESTIONS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <textarea
            value={form.signal}
            onChange={(e) => setForm({ ...form, signal: e.target.value })}
            rows={2}
            placeholder="Signal - one sentence on what this file tells us"
            aria-label="Signal"
            className="w-full rounded border border-slate-300 px-1.5 py-1 text-[11px] resize-none"
          />
          <textarea
            value={form.review_notes}
            onChange={(e) => setForm({ ...form, review_notes: e.target.value })}
            rows={2}
            placeholder="Review notes (optional)"
            aria-label="Review notes"
            className="w-full rounded border border-slate-300 px-1.5 py-1 text-[11px] resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy}
              className="text-[11px] font-medium text-white bg-brand rounded px-2 py-1 disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-[11px] font-medium text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <p className="text-[11px] text-red-600 break-words">{error}</p>}
    </div>
  );
}
