"use client";

import { usePathname } from "next/navigation";
import { AuthProvider, useAuth } from "../lib/AuthContext";
import Sidebar from "./Sidebar";
import CommandPalette from "./CommandPalette";

function Guarded({ children }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();

  // The login page and the public search page ("/") render standalone - no
  // sidebar/search chrome for a logged-out person to see. Everything else
  // is the admin console and needs a real session.
  if (pathname === "/login" || pathname === "/") return children;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-slate-400 text-sm">
        Loading…
      </div>
    );
  }

  // Not logged in - AuthProvider's own effect is already redirecting to
  // /login; render nothing in the meantime rather than flashing real data.
  if (!user) return null;

  return (
    <div className="flex min-h-full">
      <CommandPalette />
      <Sidebar />
      <main
        className="flex-1 min-w-0 bg-cream"
        style={{
          backgroundImage: "url(/bg-watermark.png)",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "left bottom",
          backgroundSize: "cover",
          backgroundAttachment: "fixed",
        }}
      >
        {children}
      </main>
    </div>
  );
}

export default function AppShell({ children }) {
  return (
    <AuthProvider>
      <Guarded>{children}</Guarded>
    </AuthProvider>
  );
}
