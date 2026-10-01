"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../lib/api";
import { formatRelativeDay } from "../lib/format";

// Universal search - Ctrl+K (Cmd+K on Mac), invoked from anywhere in the
// app. Mounted once in the root layout, not per-page, so the shortcut works
// regardless of which screen is open. Debounced live search against the
// backend (projects, people, topics/content, files, tasks) rather than
// shipping everything to the client to filter - the same reasoning behind
// every other search built server-side in this app.
//
// Shape follows the "Website Search Journey" design (product feedback, 30 Sep): type a
// few words -> grouped suggestions -> pick a result -> land on a
// destination that shows provenance (file counts) and freshness ("Last
// indexed"). "Person" opens the projects that person appears in, not a
// standalone profile - the design's own behavior contract. Every real pick
// (and every real query that never led to one) is logged server-side via
// api.logSearchOutcome() so search quality can be reviewed later, not
// guessed at - see backend SearchLog/Django admin.
const DEBOUNCE_MS = 150;
const EMPTY_RESULTS = { projects: [], stakeholders: [], topics: [], files: [], tasks: [] };

// display_name is sometimes a full disk path (folder-scanned files keep
// their original absolute path as the label) - shown as just the filename
// here so a long path can't blow out the palette's fixed width; the full
// path is still what the destination page shows.
function basename(pathLike) {
  if (!pathLike) return pathLike;
  const parts = pathLike.split(/[\\/]/);
  return parts[parts.length - 1] || pathLike;
}

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);
  // Tracks whether THIS session's query ever produced a pick, so closing
  // without one (Escape, click-away) can still log "searched but nothing
  // was chosen" - the "No useful match" / abandoned-search signal.
  const pickedRef = useRef(false);
  const lastLoggedQueryRef = useRef("");

  function logOutcome(item) {
    const q = query.trim();
    if (!q) return;
    lastLoggedQueryRef.current = q;
    api
      .logSearchOutcome({
        query: q,
        result_count: results ? Object.values(results).reduce((sum, arr) => sum + arr.length, 0) : 0,
        chosen_kind: item ? item.kind : "none",
        chosen_label: item ? item.name || item.title || item.display_name || "" : "",
        topic_id: item ? item.topic_id ?? item.id ?? null : null,
      })
      .catch(() => {}); // review logging must never surface an error to the user
  }

  function closePalette() {
    if (!pickedRef.current && query.trim() && query.trim() !== lastLoggedQueryRef.current) {
      logOutcome(null);
    }
    setOpen(false);
  }

  useEffect(() => {
    function handleKeyDown(e) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) closePalette();
        else setOpen(true);
      } else if (e.key === "Escape" && open) {
        closePalette();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, results]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults(null);
      setActiveIndex(0);
      pickedRef.current = false;
      lastLoggedQueryRef.current = "";
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
        setResults(EMPTY_RESULTS);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [query, open]);

  const flatItems = results
    ? [
        ...results.projects.map((p) => ({ kind: "project", ...p })),
        ...results.stakeholders.map((s) => ({ kind: "person", ...s })),
        ...results.topics.map((t) => ({ kind: "topic", ...t })),
        ...results.files.map((f) => ({ kind: "file", ...f })),
        ...results.tasks.map((t) => ({ kind: "task", ...t })),
      ]
    : [];

  function go(item) {
    pickedRef.current = true;
    logOutcome(item);
    setOpen(false);
    if (item.kind === "project") router.push(`/topics/?id=${encodeURIComponent(item.id)}`);
    else if (item.kind === "person") router.push(`/topics/?id=${encodeURIComponent(item.projects[0]?.topic_id)}`);
    else if (item.kind === "task") router.push(`/topics/?id=${encodeURIComponent(item.topic_id)}`);
    else if (item.kind === "file") router.push(`/topics/?id=${encodeURIComponent(item.topic_id)}`);
    else if (item.kind === "topic") router.push(`/topics/?id=${encodeURIComponent(item.topic_id)}`);
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
      onClick={closePalette}
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
            placeholder="Search projects, people, topics, files…"
            className="flex-1 text-sm outline-none placeholder:text-slate-400"
          />
          <kbd className="text-[10px] text-slate-400 border border-slate-200 rounded px-1.5 py-0.5">
            Esc
          </kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          {!query.trim() && (
            <p className="px-4 py-6 text-sm text-slate-400 text-center">
              Type to search across every project — names, people, topics, files.
            </p>
          )}
          {query.trim() && loading && !results && (
            <p className="px-4 py-6 text-sm text-slate-400 text-center">Searching…</p>
          )}
          {results && flatItems.length === 0 && !loading && (
            <div className="px-4 py-6 text-sm text-slate-400 text-center space-y-1">
              <p>No matches for &ldquo;{query}&rdquo;.</p>
              <p className="text-xs text-slate-400">
                Try a shorter term or a name. Check spelling. Only authorized, indexed sources
                appear here.
              </p>
            </div>
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
                    <Provenance fileCount={p.file_count} lastIndexed={p.last_indexed} />
                  </ResultRow>
                );
              })}
            </ResultGroup>
          )}

          {results && results.stakeholders.length > 0 && (
            <ResultGroup label="People">
              {results.stakeholders.map((s, i) => {
                runningIndex++;
                return (
                  <ResultRow
                    key={`person-${i}`}
                    active={runningIndex === activeIndex}
                    onClick={() => go({ kind: "person", ...s })}
                  >
                    <HighlightText text={s.name} query={query} className="font-medium text-slate-800" />
                    <span className="text-slate-400">
                      {" "}
                      — projects: {s.projects.map((pr) => pr.topic_name).join(", ")}
                    </span>
                  </ResultRow>
                );
              })}
            </ResultGroup>
          )}

          {results && results.topics.length > 0 && (
            <ResultGroup label="Topics">
              {results.topics.map((t) => {
                runningIndex++;
                return (
                  <ResultRow
                    key={`topic-${t.id}`}
                    active={runningIndex === activeIndex}
                    onClick={() => go({ kind: "topic", ...t })}
                    stacked
                  >
                    <div className="flex items-center gap-1 min-w-0 w-full">
                      <span className="font-medium text-slate-800 truncate">
                        {basename(t.display_name)}
                      </span>
                      <span className="text-slate-400 shrink-0"> — {t.topic_name}</span>
                      <Provenance lastIndexed={t.last_indexed} />
                    </div>
                    {t.snippet && (
                      <HighlightText
                        text={t.snippet}
                        query={query}
                        className="block text-slate-400 truncate italic text-xs w-full"
                      />
                    )}
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
                      text={basename(f.display_name)}
                      query={query}
                      className="text-slate-800 truncate font-mono text-xs"
                    />
                    <span className="text-slate-400"> — {f.topic_name}</span>
                    <Provenance lastIndexed={f.last_indexed} />
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

function ResultRow({ children, active, onClick, stacked = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-4 py-2 text-sm min-w-0 ${
        stacked ? "flex flex-col gap-0.5" : "flex items-center gap-1"
      } ${active ? "bg-brand/10" : "hover:bg-slate-50"}`}
    >
      {stacked ? (
        children
      ) : (
        <span className="flex items-center gap-1 min-w-0 truncate flex-1">{children}</span>
      )}
    </button>
  );
}

// Provenance/freshness, per the design's "Evidence links | N source items |
// Last indexed: today" - shown as a small trailing badge so it reads as
// metadata, not part of the match itself.
function Provenance({ fileCount, lastIndexed }) {
  if (fileCount == null && !lastIndexed) return null;
  const parts = [];
  if (fileCount != null) parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  if (lastIndexed) parts.push(`updated ${formatRelativeDay(new Date(lastIndexed).getTime())}`);
  return <span className="text-[11px] text-slate-300 shrink-0 ml-auto pl-2">{parts.join(" · ")}</span>;
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
