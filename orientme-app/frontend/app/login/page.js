"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { api } from "../lib/api";
import { useAuth } from "../lib/AuthContext";

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.primeCsrf();
      await api.login(username.trim(), password);
      await refresh();
      router.replace("/dashboard");
    } catch (err) {
      setError("Incorrect username or password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-cream px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <Image src="/logo-icon.png" alt="" width={32} height={32} />
          <span className="text-xl font-extrabold tracking-tight">
            <span className="text-[#1a1a1a]">Orient</span>
            <span className="text-teal">Me</span>
          </span>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg border border-slate-200 shadow-sm p-6 space-y-4"
        >
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
            <input
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
            <input
              type="password"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full px-4 py-2 text-sm rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
