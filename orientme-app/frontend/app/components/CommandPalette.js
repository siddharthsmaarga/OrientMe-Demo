"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../lib/api";

// Universal search - Ctrl+K (Cmd+K on Mac), invoked from anywhere in the
// app. Mounted once in the root layout, not per-page, so the shortcut works
// regardless of which screen is open. Debounced live search against the
// backend (project names, stakeholders, tasks, files) rather than shipping
// everything to the client to filter - the same reasoning behind every
// other search built server-side in this app.
const DEBOUNCE_MS = 150;

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    function handleKeyDown(e) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    // A visible button (the Sidebar's search hint) can't reach this
    // component's state directly without prop-drilling/context, so it opens
    // the palette via a plain window event instead - the same shortcut a
    // hotkey uses, just triggered by a click.
    function handleOpenEvent() {
      setOpen(true);
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("orientme:open-search", handleOpenEvent);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("orientme:open-search", handleOpenEvent);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults(null);
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api.search(query.trim());
        setResults(data);
      } catch {
        setResults({ projects: [], stakeholders: [], tasks: [], files: [] });
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [query, open]);

  const flatItems = results
    ? [
        ...results.projects.map((p) => ({ kind: "project", ...p })),
        ...results.stakeholders.map((s) => ({ kind: "stakeholder", ...s })),
        ...results.tasks.map((t) => ({ kind: "task", ...t })),
        ...results.files.map((f) => ({ kind: "file", ...f })),
      ]
    : [];

  function go(item) {
    setOpen(false);
    if (item.kind === "project") router.push(`/topics/${item.id}`);
    else if (item.kind === "stakeholder") router.push(`/topics/${item.topic_id}`);
    else if (item.kind === "task") router.push(`/topics/${item.topic_id}`);
    else if (item.kind === "file") router.push(`/topics/${item.topic_id}`);
  }

  function handleInputKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && flatItems[activeIndex]) {
      e.preventDefault();
      go(flatItems[activeIndex]);
    }
  }

  if (!open) return null;

  let runningIndex = -1;

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-start justify-center pt-[12vh] p-4 z-[100]"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-full max-w-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
          <span className="text-slate-400">⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="Search projects, stakeholders, tasks, files…"
            className="flex-1 text-sm outline-none placeholder:text-slate-400"
          />
          <kbd className="text-[10px] text-slate-400 border border-slate-200 rounded px-1.5 py-0.5">
            Esc
          </kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          {!query.trim() && (
            <p className="px-4 py-6 text-sm text-slate-400 text-center">
              Type to search across every project — names, stakeholders, tasks, files.
            </p>
          )}
          {query.trim() && loading && !results && (
            <p className="px-4 py-6 text-sm text-slate-400 text-center">Searching…</p>
          )}
          {results && flatItems.length === 0 && !loading && (
            <p className="px-4 py-6 text-sm text-slate-400 text-center">
              No matches for &ldquo;{query}&rdquo;.
            </p>
          )}

          {results && results.projects.length > 0 && (
            <ResultGroup label="Projects">
              {results.projects.map((p) => {
                runningIndex++;
                return (
                  <ResultRow
                    key={`project-${p.id}`}
                    active={runningIndex === activeIndex}
                    onClick={() => go({ kind: "project", ...p })}
                  >
                    <HighlightText text={p.name} query={query} className="font-medium text-slate-800" />
                    {p.one_liner && (
                      <span className="text-slate-400 truncate"> — {p.one_liner}</span>
                    )}
                  </ResultRow>
                );
              })}
            </ResultGroup>
          )}

          {results && results.stakeholders.length > 0 && (
            <ResultGroup label="Stakeholders">
              {results.stakeholders.map((s, i) => {
                runningIndex++;
                return (
                  <ResultRow
                    key={`stakeholder-${i}`}
                    active={runningIndex === activeIndex}
                    onClick={() => go({ kind: "stakeholder", ...s })}
                  >
                    <HighlightText text={s.name} query={query} className="font-medium text-slate-800" />
                    <span className="text-slate-400"> — {s.topic_name}</span>
                  </ResultRow>
                );
              })}
            </ResultGroup>
          )}

          {results && results.tasks.length > 0 && (
            <ResultGroup label="Tasks">
              {results.tasks.map((t) => {
                runningIndex++;
                return (
                  <ResultRow
                    key={`task-${t.id}`}
                    active={runningIndex === activeIndex}
                    onClick={() => go({ kind: "task", ...t })}
                  >
                    <HighlightText text={t.title} query={query} className="text-slate-800 truncate" />
                    <span className="text-slate-400"> — {t.topic_name}</span>
                  </ResultRow>
                );
              })}
            </ResultGroup>
          )}

          {results && results.files.length > 0 && (
            <ResultGroup label="Files">
              {results.files.map((f) => {
                runningIndex++;
                return (
                  <ResultRow
                    key={`file-${f.id}`}
                    active={runningIndex === activeIndex}
                    onClick={() => go({ kind: "file", ...f })}
                  >
                    <HighlightText
                      text={f.display_name}
                      query={query}
                      className="text-slate-800 truncate font-mono text-xs"
                    />
                    <span className="text-slate-400"> — {f.topic_name}</span>
                  </ResultRow>
                );
              })}
            </ResultGroup>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultGroup({ label, children }) {
  return (
    <div className="mb-1 last:mb-0">
      <p className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      {children}
    </div>
  );
}

function ResultRow({ children, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-4 py-2 text-sm flex items-center gap-1 min-w-0 ${
        active ? "bg-brand/10" : "hover:bg-slate-50"
      }`}
    >
      <span className="flex items-center gap-1 min-w-0 truncate">{children}</span>
    </button>
  );
}

// Live highlight of the matched substring - the same pattern every command
// palette (Notion, Linear, Slack) uses so the eye can immediately see why a
// result matched, not just that it did.
function HighlightText({ text, query, className }) {
  if (!query.trim()) return <span className={className}>{text}</span>;
  const idx = text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (idx === -1) return <span className={className}>{text}</span>;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.trim().length);
  const after = text.slice(idx + query.trim().length);
  return (
    <span className={className}>
      {before}
      <mark className="bg-amber-200 text-slate-900 rounded-sm">{match}</mark>
      {after}
    </span>
  );
}
