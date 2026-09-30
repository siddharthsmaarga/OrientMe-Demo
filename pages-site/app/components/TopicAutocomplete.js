"use client";

import { useEffect, useRef, useState } from "react";

// Replaces the plain <select> project-picker used across the Transcripts
// page - ported from the real app, built after direct product feedback that
// scrolling a long plain <select> to find one project among many is a
// pain, and an autocomplete would be quicker. Type to filter, arrow keys to
// move, Enter/click to pick - no new dependency (plain input + a
// positioned list).
export default function TopicAutocomplete({ topics, value, onChange, placeholder = "Assign to project…" }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const boxRef = useRef(null);

  const selected = topics.find((t) => String(t.id) === String(value));

  useEffect(() => {
    setQuery(selected ? selected.name : "");
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onClickOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const filtered = topics.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase()));

  function pick(topic) {
    onChange(String(topic.id));
    setQuery(topic.name);
    setOpen(false);
  }

  function handleKeyDown(e) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[activeIndex]) pick(filtered[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} className="relative w-full sm:w-56">
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
          setOpen(true);
          if (value) onChange("");
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={topics.length === 0}
        className="w-full rounded-md border border-border-warm px-2 py-1.5 text-sm bg-white disabled:opacity-50"
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto rounded-md border border-border-warm bg-white shadow-lg text-sm">
          {filtered.map((t, i) => (
            <li
              key={t.id}
              onMouseDown={() => pick(t)}
              className={`px-3 py-1.5 cursor-pointer truncate ${
                i === activeIndex ? "bg-teal-tint text-teal-dark" : "hover:bg-cream"
              }`}
            >
              {t.name}
            </li>
          ))}
        </ul>
      )}
      {open && query && filtered.length === 0 && (
        <ul className="absolute z-10 mt-1 w-full rounded-md border border-border-warm bg-white shadow-lg text-sm">
          <li className="px-3 py-1.5 text-ink-muted">No matching project</li>
        </ul>
      )}
    </div>
  );
}
