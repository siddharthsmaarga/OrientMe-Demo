"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "./lib/api";
import { TYPE_LABELS } from "./lib/format";

// The public front door - no login required. Regular employees land here
// and only here: one search bar, type a natural-language request ("what's
// the status of the Gokul project"), get back an AI-cited answer. This
// replaced the old chat-first home page after it moved to /dashboard as the
// admin-only project console (create/edit/ingest/settings still require
// real login - see AppShell's Guarded component).
export default function PublicOrient() {
  const [query, setQuery] = useState("");
  const [state, setState] = useState("idle"); // idle | loading | result | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function runSearch(text, topicId) {
    setState("loading");
    setError(null);
    try {
      const data = await api.orient(text, topicId);
      setResult(data);
      setState("result");
    } catch (e) {
      setError(e.message);
      setState("error");
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!query.trim()) return;
    runSearch(query.trim());
  }

  function pickCandidate(candidateId) {
    runSearch(query.trim(), candidateId);
  }

  function reset() {
    setQuery("");
    setState("idle");
    setResult(null);
    setError(null);
  }

  return (
    <div className="min-h-screen bg-cream flex flex-col items-center px-4 py-16">
      <Link href="/dashboard" className="absolute top-4 right-5 text-xs text-slate-400 hover:text-teal-dark">
        Admin login →
      </Link>

      <div className="flex items-center gap-2 mb-10">
        <img src="/logo-icon.png" alt="" width={36} height={36} />
        <span className="text-2xl font-extrabold tracking-tight">
          <span className="text-[#1a1a1a]">Orient</span>
          <span className="text-teal">Me</span>
        </span>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-2xl">
        <div className="flex items-center gap-2 bg-white rounded-full border border-slate-200 shadow-sm px-5 py-3.5 focus-within:border-teal transition-colors">
          <SearchIcon />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Orient me… ask about any project, person, or meeting"
            className="flex-1 text-base outline-none placeholder:text-slate-400 bg-transparent"
          />
          {state === "loading" ? (
            <span className="text-xs text-slate-400 shrink-0">Searching…</span>
          ) : (
            <button
              type="submit"
              className="text-sm font-medium text-white bg-brand hover:bg-brand-dark px-4 py-1.5 rounded-full shrink-0"
            >
              Orient me
            </button>
          )}
        </div>
      </form>

      <div className="w-full max-w-2xl mt-6">
        {state === "error" && (
          <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">
            Couldn&apos;t reach OrientMe: {error}
          </div>
        )}

        {state === "result" && result?.outcome === "matched" && (
          <MatchedResult result={result} onReset={reset} />
        )}

        {state === "result" && result?.outcome === "ambiguous" && (
          <div className="rounded-lg bg-white border border-slate-200 p-5">
            <p className="text-sm text-slate-600 mb-3">
              A few projects could match &ldquo;{query}&rdquo; — which one did you mean?
            </p>
            <div className="space-y-2">
              {result.candidates.map((c) => (
                <button
                  key={c.id}
                  onClick={() => pickCandidate(c.id)}
                  className="w-full text-left px-4 py-2.5 rounded-md border border-slate-200 hover:border-teal hover:bg-teal-tint transition-colors"
                >
                  <span className="font-medium text-slate-800">{c.name}</span>
                  <span className="text-xs text-slate-400 ml-2">
                    {TYPE_LABELS[c.topic_type] || c.topic_type}
                  </span>
                  {c.one_liner && <p className="text-xs text-slate-400 mt-0.5">{c.one_liner}</p>}
                </button>
              ))}
            </div>
          </div>
        )}

        {state === "result" && result?.outcome === "no_match" && (
          <div className="rounded-lg bg-white border border-slate-200 p-5 text-sm text-slate-600">
            No project matches &ldquo;{query}&rdquo; yet
            {result.suggested_name ? ` (closest guess: "${result.suggested_name}")` : ""}. Ask an
            admin to set this project up in OrientMe.
          </div>
        )}

        {state === "idle" && (
          <p className="text-center text-sm text-slate-400 mt-4">
            Try: &ldquo;what&apos;s the status of the Gokul project&rdquo; or &ldquo;what did we last
            discuss with P&amp;G&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}

function MatchedResult({ result, onReset }) {
  const { topic, answer } = result;
  return (
    <div className="rounded-lg bg-white border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">
            {TYPE_LABELS[topic.topic_type] || topic.topic_type}
          </p>
          <h2 className="text-lg font-semibold text-slate-900">{topic.name}</h2>
        </div>
        <button onClick={onReset} className="text-xs text-slate-400 hover:text-teal-dark">
          New search
        </button>
      </div>
      {!answer?.is_llm && answer?.generation_note && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">
          {answer.generation_note}
        </p>
      )}
      <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{answer?.content}</p>
      {answer?.source_files?.length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-100">
          <p className="text-xs font-medium text-slate-500 mb-1.5">Sources</p>
          <ul className="space-y-1">
            {answer.source_files.map((s, i) => (
              <li key={i} className="text-xs text-slate-400 truncate">
                {s.display_name || s.path}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-slate-400 shrink-0">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
