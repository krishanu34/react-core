"use client";

import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, AlertCircle } from "lucide-react";
import { login, isAuthenticated, postAuthDestination } from "@/lib/auth";
import { queryClient } from "@/lib/query-client";
import { getIntegrationParams } from "@/lib/launch-mode";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Route post-auth through Daemon Setup — local file access gates every
  // workspace route, and Setup hands straight over when the daemon is already up.
  const destination = postAuthDestination(searchParams.get("from"));

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);

  // Defence-in-depth: clear any stale cached data from a previous session
  // so a new login never inherits another user's queries.
  useEffect(() => {
    queryClient.clear();
  }, []);

  // If integration params are present, redirect to /integrate (SSO flow)
  useEffect(() => {
    const params = getIntegrationParams();
    if (params) {
      const integrateUrl = `/integrate?token=${encodeURIComponent(params.token)}&project_id=${encodeURIComponent(params.projectId)}&mode=integrated`;
      router.replace(integrateUrl);
    }
  }, [router]);

  // Already logged in → redirect
  useEffect(() => {
    if (isAuthenticated()) router.replace(destination);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(username.trim(), password);
      // Full navigation ensures the shell, proxy, and layouts re-initialize
      // with the fresh auth token. router.replace can fail to trigger a visible
      // transition in the App Router when called from an async handler.
      window.location.href = destination;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex flex-col items-center mb-8 gap-3">
          <img src="/cgi-logo.png" alt="CGI" className="h-14 w-auto object-contain" />
          <div className="text-center">
            <h1 className="text-xl font-bold text-slate-100">DevSphere AI</h1>
            <p className="text-sm text-slate-500 mt-0.5">Sign in to your workspaces</p>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Username */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Username
              </label>
              <input
                type="text"
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all"
                placeholder="admin"
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                  Password
                </label>
                <Link
                  href="/forgot-username"
                  tabIndex={-1}
                  className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                >
                  Forgot username?
                </Link>
              </div>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all"
                placeholder="••••••••"
              />
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-red-800/50 bg-red-950/40 px-3 py-2.5 text-sm text-red-400">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors mt-2"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-slate-500">
          Don&apos;t have an account?{" "}
          <Link
            href="/register"
            className="font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <Loader2 className="h-6 w-6 text-indigo-400 animate-spin" />
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
