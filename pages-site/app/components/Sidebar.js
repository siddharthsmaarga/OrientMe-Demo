"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/AuthContext";

// Each item gets its own solid brand-colored square "logo tile" instead of
// a thin stroke icon - matches the demo's multi-accent palette (cyan/
// green/orange/purple/brand) so each section reads as a distinct, filled
// icon rather than a plain text list. Grouped into "Workspace" (the things
// people work inside day to day) and "Configure" (account/system setup) so
// 5 items still read as organized, not just a longer flat list.
const NAV_GROUPS = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Projects", icon: TopicsIcon, tile: "bg-teal" },
      { href: "/transcripts", label: "Transcripts", icon: TranscriptsIcon, tile: "bg-brand" },
    ],
  },
  {
    label: "Configure",
    items: [{ href: "/settings", label: "Settings", icon: SettingsIcon, tile: "bg-accent-orange" }],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isAdmin, logout } = useAuth();
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef(null);
  const [recentTopics, setRecentTopics] = useState([]);

  // "Recent" - the sidebar's own real content instead of empty space below
  // nav, and genuinely useful: the last few projects with any activity,
  // reusing last_activity_at (already computed server-side for the
  // dashboard's own "Stale" badge) rather than inventing new per-viewer
  // tracking for something a shared, durable field already answers.
  useEffect(() => {
    api
      .listTopics()
      .then((topics) => {
        const sorted = [...topics]
          .filter((t) => t.last_activity_at)
          .sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at));
        setRecentTopics(sorted.slice(0, 3));
      })
      .catch(() => setRecentTopics([]));
  }, [pathname]);

  // Close the profile popover on outside click, and whenever the route
  // changes (e.g. after clicking "Profile settings" inside it).
  useEffect(() => {
    function handleClickOutside(e) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target)) {
        setProfileMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    setProfileMenuOpen(false);
  }, [pathname]);

  return (
    <aside className="w-56 shrink-0 bg-[#fcfbf7] border-r border-border-warm flex flex-col h-screen sticky top-0 px-3.5 py-5">
      <Link
        href="/dashboard"
        className="flex items-center gap-2 px-2 pb-4 mb-2 border-b border-border-warm"
      >
        <Image src="/logo-icon.png" alt="" width={28} height={28} className="shrink-0" />
        <span className="text-[16px] font-extrabold tracking-tight">
          <span className="text-[#1a1a1a]">Orient</span>
          <span className="text-teal">Me</span>
        </span>
      </Link>

      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event("orientme:open-search"))}
        className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg border border-border-warm bg-white text-ink-muted hover:border-teal hover:text-teal-dark transition-colors text-sm"
      >
        <SearchIcon />
        <span className="flex-1 text-left">Search</span>
        <kbd className="text-[10px] font-medium border border-border-warm rounded px-1 py-0.5">
          Ctrl K
        </kbd>
      </button>

      <div className="flex-1 flex flex-col gap-4 overflow-y-auto">
        {NAV_GROUPS.map((group, gi) => (
          <nav
            key={group.label}
            className={`flex flex-col gap-1.5 ${gi > 0 ? "mt-1 pt-3 border-t border-border-warm" : ""}`}
          >
            <p className="text-[10px] font-bold uppercase tracking-wider text-ink-muted px-2 mb-1">
              {group.label}
            </p>
            {group.items.map((item) => {
              const active =
                item.href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-2 py-2 rounded-xl text-sm font-semibold transition-colors ${
                    active ? "bg-[#1a1a1a]/[0.05]" : "hover:bg-[#1a1a1a]/[0.03]"
                  }`}
                >
                  <span
                    className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.4)] ${item.tile} ${
                      active ? "ring-2 ring-offset-1 ring-offset-[#fcfbf7] ring-[#1a1a1a]/15" : ""
                    }`}
                  >
                    <Icon />
                  </span>
                  <span className={`flex-1 ${active ? "text-[#1a1a1a]" : "text-ink-muted"}`}>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        ))}

        {/* Real content, not decoration, filling the space nav's short item
            count used to leave blank - the last few projects with activity,
            one click back into them. */}
        {recentTopics.length > 0 && (
          <div className="mt-1 pt-3 border-t border-border-warm">
            <p className="text-[10px] font-bold uppercase tracking-wider text-ink-muted px-2 mb-1">Recent</p>
            <div className="flex flex-col gap-0.5">
              {recentTopics.map((t) => (
                <Link
                  key={t.id}
                  href={`/topics/?id=${encodeURIComponent(t.id)}`}
                  className="px-2 py-1.5 rounded-lg text-[13px] text-ink-muted hover:text-[#1a1a1a] hover:bg-[#1a1a1a]/[0.03] truncate transition-colors"
                  title={t.name}
                >
                  {t.name}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="relative border-t border-border-warm pt-3 mt-2" ref={profileMenuRef}>
        {profileMenuOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border border-border-warm bg-white shadow-lg overflow-hidden">
            <Link
              href="/profile"
              onClick={() => setProfileMenuOpen(false)}
              className="flex items-center gap-2 px-3 py-2.5 text-sm font-medium text-[#1a1a1a] hover:bg-teal-tint/50 transition-colors"
            >
              <ProfileGearIcon />
              Profile settings
            </Link>
            <button
              type="button"
              onClick={async () => {
                setProfileMenuOpen(false);
                await logout();
                router.replace("/login");
              }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm font-medium text-[#1a1a1a] hover:bg-red-50 hover:text-red-600 transition-colors border-t border-border-warm"
            >
              <LogoutIcon />
              Log out
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => setProfileMenuOpen((o) => !o)}
          className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors ${
            profileMenuOpen ? "bg-teal-tint" : "hover:bg-teal-tint/50"
          }`}
        >
          <span className="w-8 h-8 rounded-full bg-brand text-white flex items-center justify-center text-sm font-bold shrink-0">
            {(user?.display_name || "?").charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block text-sm font-semibold text-[#1a1a1a] truncate">
              {user?.display_name || "…"}
            </span>
            <span className="block text-[11px] text-ink-muted capitalize">{isAdmin ? "Admin" : "User"}</span>
          </span>
        </button>
      </div>
    </aside>
  );
}

function ProfileGearIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

// Nav tile icons always sit on a solid brand-color square now, so they're
// always white - no more active/inactive stroke-color branching.
function TopicsIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M3 9h18" />
    </svg>
  );
}

function TranscriptsIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
