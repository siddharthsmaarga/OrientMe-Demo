"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { api } from "../lib/api";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const uid = searchParams.get("uid") || "";
  const token = searchParams.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setLoading(true);
    try {
      await api.confirmPasswordReset(uid, token, password);
      setDone(true);
    } catch (err) {
      const match = err.message.match(/"error":\s*"([^"]+)"/);
      setError(match ? match[1] : "Couldn't reset your password. Please try again.");
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

        <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-6 space-y-4">
          <h1 className="text-lg font-semibold text-slate-900">Set a new password</h1>

          {!uid || !token ? (
            <p className="text-sm text-red-600">
              This reset link is missing its token. Request a new one from the{" "}
              <Link href="/forgot-password" className="underline">
                forgot password
              </Link>{" "}
              page.
            </p>
          ) : done ? (
            <>
              <p className="text-sm text-slate-600">Your password has been reset.</p>
              <Link
                href="/login"
                className="block text-center w-full px-4 py-2 text-sm rounded-md bg-brand text-white hover:bg-brand-dark"
              >
                Sign in
              </Link>
            </>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  New password
                </label>
                <input
                  type="password"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Confirm new password
                </label>
                <input
                  type="password"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full px-4 py-2 text-sm rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
              >
                {loading ? "Resetting…" : "Reset password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
