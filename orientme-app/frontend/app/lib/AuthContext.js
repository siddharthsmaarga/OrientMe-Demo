"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api } from "./api";

const AuthContext = createContext(null);

// Public routes reachable without a session - the search page and the login
// page. (Sign-up and email password reset are switched off: the app has one
// shared login.) Exported so AppShell's own render guard (no sidebar/chrome on
// these pages) stays in sync with this redirect list.
export const PUBLIC_PATHS = new Set(["/", "/login"]);

// Real Django sessions gate the whole app - this provider checks once on load
// whether anyone's logged in, and redirects to /login if not. There is one
// shared login; changing Settings needs a separate password (see the
// Settings page), not a role.
export function AuthProvider({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      await api.primeCsrf();
      const data = await api.me();
      setUser(data.authenticated ? data : null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Every route not in PUBLIC_PATHS still requires a real session.
    if (!loading && !user && !PUBLIC_PATHS.has(pathname)) {
      router.replace("/login");
    }
  }, [loading, user, pathname, router]);

  async function logout() {
    try {
      await api.logout();
    } finally {
      setUser(null);
      router.replace("/login");
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        refresh,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
