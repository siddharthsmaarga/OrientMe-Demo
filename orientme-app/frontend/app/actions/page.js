"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatMeetingDate, taskUrgency, URGENCY_STYLES } from "../lib/format";

// The Action Center: every open task across every project, grouped by
// project, each one "AI Execute"-able - a ready-to-edit draft (a status
// email, an agenda line, whatever the task's own wording calls for)
// instead of writing it from scratch. Never sends anything itself - the
// draft is only ever reviewed, edited, and copied by a person, matching the
// PRD's own "no email sending / no external writes" non-goal.
export default function ActionsPage() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTask, setActiveTask] = useState(null);

  async function load() {
    try {
      const all = await api.getTasks();
      setTasks(all.filter((t) => t.status !== "done"));
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

  const groups = {};
  tasks.forEach((t) => {
    const key = t.topic_name || "Unassigned";
    (groups[key] ||= []).push(t);
  });
  const groupNames = Object.keys(groups).sort();

  return (
    <div className="max-w-4xl mx-auto px-6 py-10 w-full">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900">Action Center</h1>
        <p className="text-slate-500 mt-1">
          Every open commitment across every project, in one place — click{" "}
          <span className="font-medium text-brand">AI Execute</span> for a ready-to-edit draft.
        </p>
      </header>

      {error && <p className="text-red-600 text-sm mb-4">Error: {error}</p>}
      {loading && <p className="text-sm text-slate-400">Loading…</p>}

      {!loading && groupNames.length === 0 && (
        <p className="text-sm text-slate-400">
          Nothing open right now — action items are pulled automatically from meeting transcripts
          once ingested.
        </p>
      )}

      <div className="space-y-6">
        {groupNames.map((name) => (
          <section key={name} className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <h2 className="text-sm font-semibold text-slate-700 px-4 py-3 border-b border-slate-100 bg-slate-50">
              {name}
            </h2>
            <ul className="divide-y divide-slate-100">
              {groups[name].map((t) => (
                <TaskRow key={t.id} task={t} onExecute={() => setActiveTask(t)} />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {activeTask && <AiExecuteModal task={activeTask} onClose={() => setActiveTask(null)} />}
    </div>
  );
}

function TaskRow({ task, onExecute }) {
  const urgency = taskUrgency(task);
  const style = urgency ? URGENCY_STYLES[urgency] : null;
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-slate-800 truncate">{task.title}</p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {task.assignee && <span className="text-xs text-slate-400">{task.assignee}</span>}
          {task.due_date && style && (
            <span
              className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium ${style.bg} ${style.text} border ${style.border}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
              {formatMeetingDate(task.due_date)}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onExecute}
        className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-md border-2 border-brand text-brand hover:bg-brand hover:text-white transition-colors"
      >
        AI Execute
      </button>
    </li>
  );
}

function AiExecuteModal({ task, onClose }) {
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setLoading(true);
    setCopied(false);
    try {
      const result = await api.aiExecuteTask(task.id);
      setDraft(result.draft || "");
      setNote(result.is_llm ? null : result.note);
    } catch (e) {
      setDraft("");
      setNote(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the browser - the text is still
      // selectable/editable in the textarea either way, so this never blocks.
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="text-sm font-semibold text-slate-800">AI-drafted for this task</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">
            ×
          </button>
        </div>
        <p className="text-xs text-slate-500 mb-3 truncate">{task.title}</p>

        <textarea
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm resize-none"
          rows={7}
          value={loading ? "Drafting…" : draft}
          disabled={loading}
          onChange={(e) => setDraft(e.target.value)}
        />
        {note && !loading && <p className="text-xs italic text-amber-700 mt-2">{note}</p>}

        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={generate}
            disabled={loading}
            className="px-3 py-1.5 text-xs rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Regenerate
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={loading || !draft}
            className="px-3 py-1.5 text-xs rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
