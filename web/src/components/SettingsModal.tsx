"use client";

import { X, Save, Trash2, CheckCircle2, AlertCircle } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  CredentialSummary,
  Provider,
  deleteCredential,
  listCredentials,
  upsertCredential,
} from "@/lib/settings";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const PROVIDERS: { key: Provider; label: string; hint: string }[] = [
  {
    key: "jira",
    label: "Jira",
    hint: "Cloud: use email + API token. Server/DC: leave email blank and paste a Personal Access Token.",
  },
  {
    key: "confluence",
    label: "Confluence",
    hint: "Base URL usually ends with /wiki on Cloud. Cloud: email + API token. Server/DC: PAT only.",
  },
];

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [loaded, setLoaded] = useState(false);
  const [existing, setExisting] = useState<Record<Provider, CredentialSummary | null>>({
    jira: null,
    confluence: null,
  });
  const [globalError, setGlobalError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await listCredentials();
      const map: Record<Provider, CredentialSummary | null> = {
        jira: null,
        confluence: null,
      };
      for (const c of list) map[c.provider] = c;
      setExisting(map);
      setGlobalError(null);
    } catch (err) {
      setGlobalError((err as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setLoaded(false);
      void reload();
    }
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-16 sm:pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-[var(--radius-bell-lg)] bg-white shadow-[var(--shadow-bell-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-bell-border px-5 py-3">
          <h2 className="text-lg font-semibold text-bell-ink">
            Settings — Connectors
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-full p-1 text-bell-slate hover:bg-bell-chrome hover:text-bell-blue"
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {!loaded && (
            <p className="text-sm text-bell-muted">Loading…</p>
          )}

          {globalError && (
            <div className="mb-3 flex items-start gap-2 rounded-[var(--radius-bell)] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
              <p>{globalError}</p>
            </div>
          )}

          {loaded && (
            <div className="flex flex-col gap-6">
              {PROVIDERS.map((p) => (
                <ProviderForm
                  key={p.key}
                  provider={p.key}
                  label={p.label}
                  hint={p.hint}
                  existing={existing[p.key]}
                  onChanged={reload}
                />
              ))}

              <p className="text-xs text-bell-muted">
                Credentials are stored in the App DB against user{" "}
                <code className="rounded bg-bell-chrome px-1">admin</code>.
                Tokens are shown masked. Re-enter the token to update it.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ProviderFormProps {
  provider: Provider;
  label: string;
  hint: string;
  existing: CredentialSummary | null;
  onChanged: () => void | Promise<void>;
}

function ProviderForm({
  provider,
  label,
  hint,
  existing,
  onChanged,
}: ProviderFormProps) {
  const [baseUrl, setBaseUrl] = useState(existing?.base_url ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setBaseUrl(existing?.base_url ?? "");
    setEmail(existing?.email ?? "");
    setToken("");
    setError(null);
    setSuccess(null);
  }, [existing]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!baseUrl.trim()) {
      setError("Base URL is required.");
      return;
    }
    if (!token.trim()) {
      setError("Token is required (re-enter to update).");
      return;
    }
    setSaving(true);
    try {
      await upsertCredential({
        provider,
        base_url: baseUrl.trim(),
        token: token.trim(),
        email: email.trim() || null,
      });
      setSuccess("Saved.");
      setToken("");
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!existing) return;
    setDeleting(true);
    setError(null);
    setSuccess(null);
    try {
      await deleteCredential(provider);
      setSuccess("Removed.");
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="rounded-[var(--radius-bell-lg)] border border-bell-border p-4">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-bell-ink">{label}</h3>
          <p className="mt-0.5 text-xs text-bell-muted">{hint}</p>
        </div>
        {existing && (
          <span className="flex items-center gap-1 rounded-[var(--radius-bell-pill)] bg-bell-blue-soft px-2 py-0.5 text-xs font-medium text-bell-blue">
            <CheckCircle2 size={12} aria-hidden />
            Configured · {existing.auth_type.toUpperCase()}
          </span>
        )}
      </header>

      <form onSubmit={handleSave} className="grid grid-cols-1 gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-bell-slate">
          Base URL
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://acme.atlassian.net"
            className="rounded-[var(--radius-bell)] border border-bell-border bg-white px-3 py-2 text-sm text-bell-ink placeholder:text-bell-muted focus:border-bell-blue focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-bell-slate">
          Email <span className="font-normal text-bell-muted">(Atlassian Cloud only)</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@acme.com"
            className="rounded-[var(--radius-bell)] border border-bell-border bg-white px-3 py-2 text-sm text-bell-ink placeholder:text-bell-muted focus:border-bell-blue focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-bell-slate">
          API token / PAT
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={existing ? existing.token_masked : "paste token"}
            autoComplete="off"
            className="rounded-[var(--radius-bell)] border border-bell-border bg-white px-3 py-2 text-sm text-bell-ink placeholder:text-bell-muted focus:border-bell-blue focus:outline-none"
          />
        </label>

        {(error || success) && (
          <div
            className={`rounded-[var(--radius-bell)] px-3 py-2 text-xs ${
              error
                ? "border border-red-200 bg-red-50 text-red-800"
                : "border border-green-200 bg-green-50 text-green-800"
            }`}
            role={error ? "alert" : "status"}
          >
            {error || success}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {existing && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || saving}
              className="flex items-center gap-1 rounded-[var(--radius-bell-pill)] border border-bell-border px-3 py-1.5 text-xs font-medium text-bell-slate transition-colors hover:border-red-400 hover:text-red-600 disabled:opacity-50"
            >
              <Trash2 size={14} aria-hidden />
              Delete
            </button>
          )}
          <button
            type="submit"
            disabled={saving || deleting}
            className="flex items-center gap-1 rounded-[var(--radius-bell-pill)] bg-bell-blue px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-bell-blue-dark disabled:cursor-not-allowed disabled:bg-bell-border disabled:text-bell-muted"
          >
            <Save size={14} aria-hidden />
            {saving ? "Saving…" : existing ? "Update" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}
