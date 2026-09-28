"use client";

/**
 * /forgot-username — look up the username registered to an email address.
 *
 * Shows the username on screen because there is no outbound mail configured. See
 * the trade-off note on `POST /auth/recover-username`: this confirms whether an
 * address is registered. Once SMTP exists, the backend should mail the username
 * and return the same response either way, and this page should just say
 * "check your inbox".
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, ArrowRight, Check, Copy, Loader2, Mail } from "lucide-react";
import { recoverUsername } from "@/lib/auth";

export default function ForgotUsernamePage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setUsername(null);
    setLoading(true);
    try {
      setUsername(await recoverUsername(email.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="ds-logo flex h-14 w-14 items-center justify-center rounded-2xl text-2xl font-black text-white">
            DS
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold text-slate-100">Find your username</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Enter the email you registered with
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
          {username ? (
            <div className="space-y-5">
              <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-4 py-4 text-center">
                <p className="text-xs uppercase tracking-wider text-emerald-500">
                  Your username
                </p>
                <p className="mt-1.5 font-mono text-lg font-semibold text-emerald-300">
                  {username}
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(username);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2500);
                  }}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded border border-emerald-800 px-2.5 py-1 text-xs text-emerald-400 transition-colors hover:border-emerald-600 hover:text-emerald-300"
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>

              <button
                type="button"
                onClick={() => router.push("/login")}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
              >
                Continue to sign in <ArrowRight className="h-4 w-4" />
              </button>

              <p className="text-center text-xs text-slate-600">
                Forgot the password too? Ask an administrator to reset it — there is no
                self-service password reset yet.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" />
                  <input
                    type="email"
                    autoComplete="email"
                    autoFocus
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 py-2.5 pl-9 pr-3.5 text-sm text-slate-100 placeholder-slate-600 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                    placeholder="ada@example.com"
                  />
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-800/50 bg-red-950/40 px-3 py-2.5 text-sm text-red-400">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !email.includes("@")}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Looking up…
                  </>
                ) : (
                  "Find my username"
                )}
              </button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-slate-500">
          <Link
            href="/login"
            className="inline-flex items-center gap-1 font-medium text-indigo-400 transition-colors hover:text-indigo-300"
          >
            <ArrowLeft className="h-3 w-3" /> Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
