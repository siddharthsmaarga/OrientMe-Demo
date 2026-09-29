"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { api } from "../lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.requestPasswordReset(email.trim());
    } finally {
      setLoading(false);
      setSubmitted(true);
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
          <h1 className="text-lg font-semibold text-slate-900">Reset your password</h1>

          {submitted ? (
            <>
              <p className="text-sm text-slate-600">
                Demo mode — this is a simulated answer, not a real email send. There&apos;s no
                real account backend in this build, so nothing was actually sent.
              </p>
              <Link
                href="/reset-password?uid=demo&token=demo"
                className="block text-center w-full px-4 py-2 text-sm rounded-md bg-brand text-white hover:bg-brand-dark"
              >
                Continue with a sample reset link →
              </Link>
            </>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm text-slate-500">
                Enter the email on your account and we&apos;ll send you a link to reset your
                password.
              </p>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <input
                  type="email"
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full px-4 py-2 text-sm rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
              >
                {loading ? "Sending…" : "Send reset link"}
              </button>
            </form>
          )}

          <p className="text-center text-sm text-slate-500">
            <Link href="/login" className="text-teal-dark hover:underline font-medium">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
