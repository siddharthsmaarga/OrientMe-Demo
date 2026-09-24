"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/AuthContext";

// Presets for the providers this app has actually been run against - picking
// one auto-fills the base URL (rarely worth hand-typing) and suggests a
// model known to work with this app's forced tool-calling. "Custom" leaves
// both fields editable for anything else OpenAI-compatible.
const PROVIDER_PRESETS = {
  openrouter: {
    label: "OpenRouter",
    base_url: "https://openrouter.ai/api/v1",
    model: "openai/gpt-5.4",
    keyPlaceholder: "sk-or-...",
    keyHint: "OpenRouter API key",
  },
  groq: {
    label: "Groq",
    base_url: "https://api.groq.com/openai/v1",
    // Verified directly against a live key: openai/gpt-oss-120b silently
    // ignores forced tool_choice, and qwen/qwen3.8-27b corrupts nested JSON
    // keys on the meeting-extraction schema - gpt-oss-20b is the one that
    // held up on both the brief and extraction schemas.
    model: "openai/gpt-oss-20b",
    keyPlaceholder: "gsk_...",
    keyHint: "Groq API key",
  },
  requesty: {
    label: "Requesty",
    base_url: "https://router.requesty.ai/v1",
    model: "openai/gpt-5.4",
    keyPlaceholder: "rqsty-sk-...",
    keyHint: "Requesty API key",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    base_url: "",
    model: "",
    keyPlaceholder: "",
    keyHint: "API key",
  },
};

export default function SettingsPage() {
  const { isAdmin } = useAuth();
  const [form, setForm] = useState({
    llm_provider: "openrouter",
    llm_api_key: "",
    llm_model: "openai/gpt-5.4",
    llm_base_url: "https://openrouter.ai/api/v1",
    default_directory: "",
    stale_after_days: "14",
  });
  const [keyIsSet, setKeyIsSet] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  // Unlocked (editable) by default - a person should always be able to
  // change the provider/key/model without fighting the UI. Lock is purely
  // an accidental-edit guard someone can turn on for themselves, remembered
  // per-browser via localStorage, and always reversible with one click.
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then((data) => {
        setForm((f) => ({ ...f, ...data, llm_api_key: "" }));
        setKeyIsSet(data.llm_api_key_set);
      })
      .catch((e) => setError(e.message));
    try {
      setLocked(localStorage.getItem("orientme_settings_locked") === "1");
    } catch {
      // localStorage can be unavailable (private browsing, blocked site
      // data) - fields just stay unlocked/editable in that case.
    }
  }, []);

  function toggleLock() {
    setLocked((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("orientme_settings_locked", next ? "1" : "0");
      } catch {
        // Nothing to persist to - the toggle still works for this session.
      }
      return next;
    });
  }

  // A User can view every field but never change one - Admin keeps the
  // existing self-serve lock/unlock toggle for accidental-edit protection.
  const effectiveLocked = !isAdmin || locked;

  const preset = PROVIDER_PRESETS[form.llm_provider] || PROVIDER_PRESETS.custom;

  function handleProviderChange(provider) {
    const p = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
    setForm((f) => ({
      ...f,
      llm_provider: provider,
      llm_base_url: p.base_url || f.llm_base_url,
      llm_model: p.model || f.llm_model,
    }));
  }

  async function handleSave(e) {
    e.preventDefault();
    try {
      await api.saveSettings(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (form.llm_api_key) setKeyIsSet(true);
      setForm((f) => ({ ...f, llm_api_key: "" }));
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <Link href="/dashboard" className="text-sm text-teal-dark hover:underline">
        ← All projects
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900 mt-3 mb-1">Settings</h1>
      <p className="text-slate-500 text-sm mb-8">
        Without a key, OrientMe still ingests your files and shows you what it found — it just
        won&apos;t write a real summary until this is set.
      </p>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      <form onSubmit={handleSave} className="space-y-5">
        <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
          <div>
            <p className="text-sm font-medium text-slate-700">
              {!isAdmin
                ? "🔒 View only"
                : locked
                  ? "🔒 Provider settings are locked"
                  : "🔓 Provider settings are unlocked"}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              {!isAdmin
                ? "Your account can view these settings but can't change them — ask an Admin."
                : locked
                  ? "Unlock to change the provider, API key, model, or base URL."
                  : "Editable by default — lock these if you want to avoid changing them by accident."}
            </p>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={toggleLock}
              className={`px-3 py-1.5 text-xs font-medium rounded-md shrink-0 ${
                locked
                  ? "bg-brand text-white hover:bg-brand-dark"
                  : "border border-slate-300 text-slate-600 hover:bg-slate-100"
              }`}
            >
              {locked ? "Unlock" : "Lock"}
            </button>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Provider</label>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm bg-white disabled:bg-slate-100 disabled:text-slate-400"
            value={form.llm_provider}
            disabled={effectiveLocked}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            {Object.entries(PROVIDER_PRESETS).map(([key, p]) => (
              <option key={key} value={key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            {preset.keyHint} {keyIsSet && <span className="text-emerald-600">(already set)</span>}
          </label>
          <input
            type="password"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-400"
            value={form.llm_api_key}
            disabled={effectiveLocked}
            onChange={(e) => setForm({ ...form, llm_api_key: e.target.value })}
            placeholder={keyIsSet ? "•••••••••••••••• (leave blank to keep)" : preset.keyPlaceholder}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Model</label>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-400"
            value={form.llm_model}
            disabled={effectiveLocked}
            onChange={(e) => setForm({ ...form, llm_model: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Base URL</label>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-400"
            value={form.llm_base_url}
            disabled={effectiveLocked}
            onChange={(e) => setForm({ ...form, llm_base_url: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Default directory</label>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-400"
            value={form.default_directory}
            disabled={effectiveLocked}
            onChange={(e) => setForm({ ...form, default_directory: e.target.value })}
            placeholder="C:\Users\you\OneDrive\Projects"
          />
          <p className="text-xs text-slate-400 mt-1">
            Where you keep files on your own machine before adding them here — just a reminder to
            yourself, not something this app reads automatically yet.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Flag a project &quot;Stale&quot; after
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              className="w-24 rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-400"
              value={form.stale_after_days}
              disabled={effectiveLocked}
              onChange={(e) => setForm({ ...form, stale_after_days: e.target.value })}
            />
            <span className="text-sm text-slate-500">days without a fresh brief or new file</span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Drives the &quot;Needs attention&quot; panel and Stale badge on the dashboard.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={effectiveLocked}
            className="px-4 py-2 text-sm rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
          >
            Save
          </button>
          {saved && <span className="text-sm text-emerald-600">Saved.</span>}
        </div>
      </form>
    </div>
  );
}
