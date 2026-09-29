"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "../lib/api";
import { useAuth } from "../lib/AuthContext";

export default function ProfilePage() {
  const { user, isAdmin, refresh } = useAuth();
  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [nameError, setNameError] = useState(null);

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordError, setPasswordError] = useState(null);

  async function handleSaveName(e) {
    e.preventDefault();
    if (!displayName.trim()) return;
    setSavingName(true);
    setNameError(null);
    try {
      await api.updateProfile(displayName.trim());
      await refresh();
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch (e) {
      setNameError(e.message);
    } finally {
      setSavingName(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setPasswordError(null);
    if (newPassword !== confirmPassword) {
      setPasswordError("New password and confirmation don't match.");
      return;
    }
    setSavingPassword(true);
    try {
      await api.changePassword(oldPassword, newPassword);
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordSaved(true);
      setTimeout(() => setPasswordSaved(false), 2000);
    } catch (e) {
      setPasswordError(e.message.includes("400") ? "Current password is incorrect." : e.message);
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto px-6 py-10">
      <Link href="/dashboard" className="text-sm text-teal-dark hover:underline">
        ← All projects
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900 mt-3 mb-1">Profile</h1>
      <p className="text-slate-500 text-sm mb-8">
        Signed in as <span className="font-medium">{user?.username}</span> —{" "}
        <span className="capitalize">{isAdmin ? "Admin" : "User"}</span>
        {isAdmin
          ? ": full access to Settings and Connectors."
          : ": can view Settings and Connectors, not change them."}
      </p>

      <form onSubmit={handleSaveName} className="space-y-3 mb-10 pb-8 border-b border-slate-200">
        <h2 className="text-sm font-semibold text-slate-700">Display name</h2>
        <input
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        {nameError && <p className="text-sm text-red-600">{nameError}</p>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={savingName}
            className="px-4 py-2 text-sm rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {savingName ? "Saving…" : "Save name"}
          </button>
          {nameSaved && <span className="text-sm text-emerald-600">Saved.</span>}
        </div>
      </form>

      <form onSubmit={handleChangePassword} className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-700">Change password</h2>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Current password</label>
          <input
            type="password"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">New password</label>
          <input
            type="password"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={6}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Confirm new password</label>
          <input
            type="password"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={6}
          />
        </div>
        {passwordError && <p className="text-sm text-red-600">{passwordError}</p>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={savingPassword}
            className="px-4 py-2 text-sm rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
          >
            {savingPassword ? "Updating…" : "Update password"}
          </button>
          {passwordSaved && <span className="text-sm text-emerald-600">Updated.</span>}
        </div>
      </form>
    </div>
  );
}
