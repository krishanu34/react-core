"use client";

/**
 * /register — self-service sign-up.
 *
 * The backend signs the new account straight in, so a successful submit lands
 * the user in the app rather than bouncing back to /login. A taken username or
 * email comes back as a 409 carrying which field clashed, so the error is shown
 * against that input instead of as a generic banner.
 */

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, ArrowLeft, Check, Eye, EyeOff, Loader2, X } from "lucide-react";
import { FieldError, isAuthenticated, postAuthDestination, register } from "@/lib/auth";
import { queryClient } from "@/lib/query-client";
import { cn } from "@/lib/utils";

/** Mirrors auth/service.py — keep in step with PASSWORD_MIN_LENGTH. */
const PASSWORD_MIN_LENGTH = 8;
/** Mirrors USERNAME_PATTERN in auth/service.py. */
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const inputClass =
  "w-full rounded-lg border bg-slate-800 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 outline-none transition-all focus:ring-2";

function Field({
  label,
  error,
  children,
  hint,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium uppercase tracking-wider text-slate-400">
        {label}
      </label>
      {children}
      {error ? (
        <p className="flex items-center gap-1.5 text-xs text-red-400">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-slate-600">{hint}</p>
      ) : null}
    </div>
  );
}

function Rule({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li
      className={cn(
        "flex items-center gap-1.5 text-xs transition-colors",
        ok ? "text-emerald-400" : "text-slate-600",
      )}
    >
      {ok ? <Check className="h-3 w-3 shrink-0" /> : <X className="h-3 w-3 shrink-0" />}
      {children}
    </li>
  );
}

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const destination = postAuthDestination(searchParams.get("from"));

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    queryClient.clear();
  }, []);

  useEffect(() => {
    if (isAuthenticated()) router.replace(destination);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live rules — the same checks the server enforces, shown before submitting.
  const usernameOk = username.length >= 3 && USERNAME_PATTERN.test(username);
  const passwordOk = password.length >= PASSWORD_MIN_LENGTH;
  const confirmOk = confirm.length > 0 && confirm === password;
  const canSubmit = usernameOk && passwordOk && confirmOk && email.includes("@") && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    if (password !== confirm) {
      setFieldErrors({ confirm: "Passwords do not match." });
      return;
    }

    setLoading(true);
    try {
      await register({
        username: username.trim(),
        email: email.trim(),
        password,
        full_name: fullName.trim() || undefined,
      });
      router.replace(destination);
    } catch (err) {
      if (err instanceof FieldError && err.field) {
        setFieldErrors({ [err.field]: err.message });
      } else {
        setError(err instanceof Error ? err.message : "Registration failed");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="ds-logo flex h-14 w-14 items-center justify-center rounded-2xl text-2xl font-black text-white">
            DS
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold text-slate-100">Create your account</h1>
            <p className="mt-0.5 text-sm text-slate-500">Start building with DevSphere AI</p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            <Field
              label="Username"
              error={fieldErrors.username}
              hint="Letters, numbers, dot, underscore or hyphen."
            >
              <input
                type="text"
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setFieldErrors((f) => ({ ...f, username: "" }));
                }}
                className={cn(
                  inputClass,
                  fieldErrors.username
                    ? "border-red-700 focus:border-red-500 focus:ring-red-500/20"
                    : "border-slate-700 focus:border-indigo-500 focus:ring-indigo-500/20",
                )}
                placeholder="ada.lovelace"
              />
            </Field>

            <Field label="Email" error={fieldErrors.email}>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setFieldErrors((f) => ({ ...f, email: "" }));
                }}
                className={cn(
                  inputClass,
                  fieldErrors.email
                    ? "border-red-700 focus:border-red-500 focus:ring-red-500/20"
                    : "border-slate-700 focus:border-indigo-500 focus:ring-indigo-500/20",
                )}
                placeholder="ada@example.com"
              />
            </Field>

            <Field label="Full name (optional)">
              <input
                type="text"
                autoComplete="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className={cn(inputClass, "border-slate-700 focus:border-indigo-500 focus:ring-indigo-500/20")}
                placeholder="Ada Lovelace"
              />
            </Field>

            <Field label="Password">
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={cn(
                    inputClass,
                    "border-slate-700 pr-10 focus:border-indigo-500 focus:ring-indigo-500/20",
                  )}
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 transition-colors hover:text-slate-300"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>

            <Field label="Confirm password" error={fieldErrors.confirm}>
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setFieldErrors((f) => ({ ...f, confirm: "" }));
                }}
                className={cn(
                  inputClass,
                  fieldErrors.confirm
                    ? "border-red-700 focus:border-red-500 focus:ring-red-500/20"
                    : "border-slate-700 focus:border-indigo-500 focus:ring-indigo-500/20",
                )}
                placeholder="••••••••"
              />
            </Field>

            {/* Requirements — only once the user starts typing. */}
            {(username || password || confirm) && (
              <ul className="space-y-1 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2.5">
                <Rule ok={usernameOk}>Username is 3+ valid characters</Rule>
                <Rule ok={passwordOk}>Password is {PASSWORD_MIN_LENGTH}+ characters</Rule>
                <Rule ok={confirmOk}>Passwords match</Rule>
              </ul>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-red-800/50 bg-red-950/40 px-3 py-2.5 text-sm text-red-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating account…
                </>
              ) : (
                "Create account"
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-slate-500">
          Already have an account?{" "}
          <Link
            href="/login"
            className="inline-flex items-center gap-1 font-medium text-indigo-400 transition-colors hover:text-indigo-300"
          >
            <ArrowLeft className="h-3 w-3" /> Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-950">
          <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
        </div>
      }
    >
      <RegisterForm />
    </Suspense>
  );
}
