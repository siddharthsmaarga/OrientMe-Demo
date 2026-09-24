"use client";

import { createContext, useContext, useState } from "react";

const AuthContext = createContext(null);

// Static demo build - there is no backend session to check, so everyone is
// just always "logged in" as a demo admin. No login screen, no redirect
// logic; the real app's auth gate simply doesn't apply here.
const DEMO_USER = { username: "demo", display_name: "Demo", role: "admin" };

export function AuthProvider({ children }) {
  const [user] = useState(DEMO_USER);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading: false,
        isAdmin: true,
        refresh: async () => {},
        logout: async () => {},
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
