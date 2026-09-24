"use client";

import { usePathname } from "next/navigation";
import { AuthProvider, useAuth } from "../lib/AuthContext";
import Sidebar from "./Sidebar";
import CommandPalette from "./CommandPalette";

function Guarded({ children }) {
  const { user, loading } = useAuth();
  const pathname = usePathname();

  // The public search page ("/") renders standalone, same as the real app.
  // There's no login screen in this static demo build - AuthContext always
  // returns a logged-in demo user.
  if (pathname === "/") return children;

  if (loading || !user) return null;

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
