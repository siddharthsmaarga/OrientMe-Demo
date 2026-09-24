"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api } from "./api";

const AuthContext = createContext(null);

// Real Django sessions now gate the whole app - this provider checks once
// on load whether anyone's logged in, and redirects to /login if not. Two
// roles (admin/user) ride along on the same "who am I" call so pages can
// gate individual actions (Settings, Connectors) without a second request.
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
    // "/" is the public, no-login search page - everyone can land there.
    // Every other route still requires a real session.
    if (!loading && !user && pathname !== "/login" && pathname !== "/") {
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
