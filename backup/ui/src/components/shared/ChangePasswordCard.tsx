"use client";

/**
 * Change-password form for the signed-in user.
 *
 * Requires the current password — the server re-authenticates before writing, so
 * a stolen but unlocked session can't silently take over the account.
 *
 * Note: the JWT holds no password material, so tokens issued before the change
 * remain valid until they expire (8h). Revoking them would need a blocklist or a
 * per-user token-version claim.
 */

import { useState } from "react";
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { changePassword } from "@/lib/auth";
import { cn } from "@/lib/utils";

/** Mirrors PASSWORD_MIN_LENGTH in backend/auth/service.py. */
const PASSWORD_MIN_LENGTH = 8;

const inputClass =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20";

export function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  const longEnough = next.length >= PASSWORD_MIN_LENGTH;
  const matches = confirm.length > 0 && confirm === next;
  const differs = next.length > 0 && next !== current;
  const canSubmit = current.length > 0 && longEnough && matches && differs && !saving;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    setSaving(true);
    try {
      await changePassword(current, next);
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <KeyRound className="h-4 w-4 text-indigo-400" />
          Change password
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wider text-slate-400">
              Current password
            </label>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value);
                setError(null);
              }}
              className={inputClass}
              placeholder="••••••••"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wider text-slate-400">
              New password
            </label>
            <div className="relative">
              <input
                type={show ? "text" : "password"}
                autoComplete="new-password"
                required
                value={next}
                onChange={(e) => setNext(e.target.value)}
                className={cn(inputClass, "pr-10")}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? "Hide password" : "Show password"}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 transition-colors hover:text-slate-300"
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {next.length > 0 && !longEnough && (
              <p className="text-xs text-slate-500">
                At least {PASSWORD_MIN_LENGTH} characters.
              </p>
            )}
            {next.length > 0 && longEnough && !differs && (
              <p className="text-xs text-amber-400">
                Must be different from your current password.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wider text-slate-400">
              Confirm new password
            </label>
            <input
              type={show ? "text" : "password"}
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputClass}
              placeholder="••••••••"
            />
            {confirm.length > 0 && !matches && (
              <p className="text-xs text-red-400">Passwords do not match.</p>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-800/50 bg-red-950/40 px-3 py-2.5 text-sm text-red-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {done && (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-3 py-2.5 text-sm text-emerald-400">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Password updated. Sessions already signed in elsewhere stay valid until
                they expire.
              </span>
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Updating…
              </>
            ) : (
              "Update password"
            )}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
