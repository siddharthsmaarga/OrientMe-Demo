"use client";

import { usePathname } from "next/navigation";
import { AuthProvider, PUBLIC_PATHS, useAuth } from "../lib/AuthContext";
import Sidebar from "./Sidebar";
import CommandPalette from "./CommandPalette";

function Guarded({ children }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();

  // Public auth pages render standalone - no sidebar/search chrome for a
  // logged-out person to see. Everything else is the admin console and
  // needs a real session.
  if (PUBLIC_PATHS.has(pathname)) return children;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-slate-400 text-sm">
        Loading…
      </div>
    );
  }

  // Not logged in - nothing to render. (The demo's AuthProvider always
  // provides the fixture demo user, so this is only a safety net.)
  if (!user) return null;

  return (
    <div className="flex min-h-full">
      <CommandPalette />
      <Sidebar />
      <main
        className="flex-1 min-w-0 bg-cream"
        style={{
          backgroundImage: `url(${process.env.NEXT_PUBLIC_BASE_PATH || ""}/bg-watermark.png)`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "left bottom",
          backgroundSize: "cover",
          backgroundAttachment: "fixed",
        }}
      >
        {/* The public build uses fictional fixtures and runs Ask/Orient locally
            in the visitor's browser; other backend-only actions stay simulated. */}
        <div className="bg-brand text-white text-xs text-center py-1.5 px-4">
          Demo mode — fictional sample data. Ask/Orient runs a small model in this browser; uploads and integrations are simulations.
        </div>
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
