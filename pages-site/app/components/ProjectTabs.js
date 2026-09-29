"use client";

// The one genuinely new navigation pattern this restructure needed - no
// existing tab/segmented-control component was found anywhere in the
// frontend (confirmed via a repo-wide search) to reuse instead. Purely
// presentational: the parent page owns which tab is active (synced to a
// `?tab=` query param there, not here) so switching tabs never re-triggers
// a data fetch - all tab data is already loaded once on page mount.
export default function ProjectTabs({ tabs, activeKey, onChange }) {
  return (
    <div className="border-b border-border-warm px-6">
      <nav className="flex flex-wrap gap-1 -mb-px">
        {tabs.map((tab) => {
          const active = tab.key === activeKey;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={`px-3 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
                active
                  ? "border-brand text-brand"
                  : "border-transparent text-ink-muted hover:text-[#1a1a1a] hover:border-border-warm"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
