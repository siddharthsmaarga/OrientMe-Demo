"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/AuthContext";

// Each navigation item uses a solid color tile to match the supplied
// dashboard's icon style and separate the main sections visually.
// Settings dropped from this static demo build - there's no LLM key/
// provider to configure with no backend behind this.
const NAV_ITEMS = [
  { href: "/dashboard", label: "Projects", icon: TopicsIcon, tile: "bg-teal" },
  { href: "/tasks", label: "Board", icon: TasksIcon, tile: "bg-accent-green", badgeKey: "openTasks" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { user, isAdmin } = useAuth();
  const [openTasks, setOpenTasks] = useState(null);

  useEffect(() => {
    api
      .getTasks()
      .then((tasks) => setOpenTasks(tasks.filter((t) => t.status !== "done").length))
      .catch(() => setOpenTasks(null));
  }, [pathname]);

  const badges = { openTasks };

  return (
    <aside className="w-56 shrink-0 bg-[#fcfbf7] border-r border-border-warm flex flex-col h-screen sticky top-0 px-3.5 py-5">
      <Link
        href="/dashboard"
        className="flex items-center gap-2 px-2 pb-4 mb-2 border-b border-border-warm"
      >
        <Image src={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/logo-icon.png`} alt="" width={28} height={28} className="shrink-0" />
        <span className="text-[16px] font-extrabold tracking-tight">
          <span className="text-[#1a1a1a]">Orient</span>
          <span className="text-teal">Me</span>
        </span>
      </Link>

      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event("orientme:open-search"))}
        className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg border border-border-warm bg-white text-[#797973] hover:border-teal hover:text-teal-dark transition-colors text-sm"
      >
        <SearchIcon />
        <span className="flex-1 text-left">Search</span>
        <kbd className="text-[10px] font-medium border border-border-warm rounded px-1 py-0.5">
          Ctrl K
        </kbd>
      </button>

      <nav className="flex-1 flex flex-col gap-1.5">
        {NAV_ITEMS.map((item) => {
          const active =
            item.href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(item.href);
          const Icon = item.icon;
          const badgeValue = item.badgeKey ? badges[item.badgeKey] : null;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-2 py-2 rounded-xl text-sm font-semibold transition-colors ${
                active ? "bg-[#1a1a1a]/[0.05]" : "hover:bg-[#1a1a1a]/[0.03]"
              }`}
            >
              <span
                className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 shadow-sm ${item.tile} ${
                  active ? "ring-2 ring-offset-1 ring-offset-[#fcfbf7] ring-[#1a1a1a]/15" : ""
                }`}
              >
                <Icon />
              </span>
              <span className={`flex-1 ${active ? "text-[#1a1a1a]" : "text-[#555]"}`}>{item.label}</span>
              {badgeValue != null && (
                <span
                  className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 ${
                    active ? "bg-[#1a1a1a]/10 text-[#1a1a1a]" : "bg-black/5 text-[#797973]"
                  }`}
                >
                  {badgeValue}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Static demo build - no real profile/logout, just the demo user shown. */}
      <div className="border-t border-border-warm pt-3 mt-2">
        <div className="w-full flex items-center gap-2.5 px-2.5 py-2">
          <span className="w-8 h-8 rounded-full bg-brand text-white flex items-center justify-center text-sm font-bold shrink-0">
            {(user?.display_name || "?").charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block text-sm font-semibold text-[#1a1a1a] truncate">
              {user?.display_name || "…"}
            </span>
            <span className="block text-[11px] text-[#797973] capitalize">{isAdmin ? "Admin" : "User"}</span>
          </span>
        </div>
      </div>
    </aside>
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

function TasksIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="6" height="6" rx="1" />
      <path d="M9 8h12" />
      <rect x="3" y="14" width="6" height="6" rx="1" />
      <path d="M9 17h12" />
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
