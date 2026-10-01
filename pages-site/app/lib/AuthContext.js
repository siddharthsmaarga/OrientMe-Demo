"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

const AuthContext = createContext(null);

// Public routes that render standalone (no sidebar/search chrome) - the
// search page plus the account-creation/password-reset pages. Exported so
// AppShell's render guard stays in sync with the real app's own list.
export const PUBLIC_PATHS = new Set(["/", "/login", "/register", "/forgot-password", "/reset-password"]);

// Standalone demo build: there's no Django backend to hold a real session,
// so this always provides the fixture demo user immediately - no login
// gate, no redirect. (The real app's version of this file checks a real
// session and redirects to /login if none exists; that's not meaningful
// here since api.me() always resolves to the same demo user - see api.js.)
export function AuthProvider({ children }) {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const data = await api.me();
    setUser(data);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function logout() {
    // Demo mode has nothing real to log out of - stay signed in as the
    // demo user rather than dead-ending on a login form with no backend.
    await api.logout();
    router.replace("/home");
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAdmin: user?.role === "admin",
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
