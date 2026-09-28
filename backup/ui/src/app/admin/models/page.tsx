"use client";

/**
 * /admin/models — the model catalogue and who may use each model.
 *
 * This page is what replaces editing `AZURE_OPENAI_DEPLOYMENT` in .env and
 * restarting. Two things live here because they are meaningless apart: a model
 * nobody is allowed to use, and a grant pointing at a model that doesn't exist.
 *
 * The API key is WRITE-ONLY. It can be set here and is never read back: the
 * API returns `api_key_set` and a 4-character hint instead of the value, so a
 * live credential never reaches this page, the browser cache, or a screenshot
 * of it.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Cpu, Plus, ShieldCheck, TestTube2, Trash2, X } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/story-builder/page-header";
import {
  Button,
  Dropdown,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  Loading,
  Note,
  Pill,
  Row,
  TextInput,
} from "@/components/admin/AdminUI";
import {
  createModel,
  createPolicy,
  deleteModel,
  deletePolicy,
  fetchAdminModels,
  fetchAdminUsers,
  fetchPolicies,
  fetchTeams,
  testModel,
  updateModel,
  type AccessPolicy,
  type AdminModel,
  type AdminUser,
  type SubjectType,
  type Team,
} from "@/lib/devsphere-models-api";

const EMPTY_MODEL = {
  model_key: "",
  display_name: "",
  provider: "azure",
  model_name: "",
  endpoint_url: "",
  api_version: "2024-12-01-preview",
  api_key: "",
  context_window: 128000,
  max_output_tokens: 16000,
  tier: "balanced",
  input_cost_per_1m: 0,
  cached_input_cost_per_1m: 0,
  output_cost_per_1m: 0,
  is_active: true,
  is_default: false,
};

type Draft = typeof EMPTY_MODEL;

const TIER_OPTIONS = [
  { value: "fast", label: "fast" },
  { value: "balanced", label: "balanced" },
  { value: "deep", label: "deep" },
];

const SUBJECT_OPTIONS = [
  { value: "global", label: "Everyone" },
  { value: "role", label: "Role" },
  { value: "team", label: "Team" },
  { value: "user", label: "User" },
];

export default function AdminModelsPage() {
  const [models, setModels] = useState<AdminModel[]>([]);
  const [policies, setPolicies] = useState<AccessPolicy[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ id: number; ok: boolean; message: string } | null>(null);

  const reload = useCallback(async () => {
    const [m, p, t, u] = await Promise.all([
      fetchAdminModels(),
      fetchPolicies(),
      fetchTeams(),
      fetchAdminUsers(),
    ]);
    setModels(m);
    setPolicies(p);
    setTeams(t);
    setUsers(u);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAdminModels(), fetchPolicies(), fetchTeams(), fetchAdminUsers()]).then(
      ([m, p, t, u]) => {
        if (cancelled) return;
        setModels(m);
        setPolicies(p);
        setTeams(t);
        setUsers(u);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    setTestResult(null);
    try {
      const res = await testModel(id);
      setTestResult({ id, ok: res.success, message: res.message });
    } catch (e) {
      setTestResult({ id, ok: false, message: (e as Error).message });
    } finally {
      setTesting(null);
    }
  };

  if (loading) return <Loading label="Loading models…" />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Models"
        description="The models this install can run on, and who is allowed to use each one."
      />

      {error && <ErrorBanner message={error} />}

      {models.length === 0 && (
        <Note tone="warn">
          No models configured — every run currently uses the deployment in the backend&apos;s{" "}
          <code className="rounded bg-slate-800 px-1 py-0.5 font-mono">.env</code>. Add one here, or
          run <code className="rounded bg-slate-800 px-1 py-0.5 font-mono">python db/seed_models.py</code>{" "}
          to import the .env model, to manage models from the database.
        </Note>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between p-4 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Cpu className="h-4 w-4 text-violet-400" /> Catalogue
          </CardTitle>
          {!draft && (
            <Button tone="primary" size="sm" onClick={() => setDraft({ ...EMPTY_MODEL })}>
              <Plus className="h-3.5 w-3.5" /> Add model
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-2 p-4 pt-0">
          {models.length === 0 ? (
            <EmptyState icon={Cpu} title="No models yet" hint="Add one to start managing model access." />
          ) : (
            models.map((m) => (
              <Row key={m.id}>
                <div className="min-w-[200px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-100">{m.display_name}</span>
                    {m.is_default && <Pill tone="accent">default</Pill>}
                    {!m.is_active && <Pill tone="neutral">inactive</Pill>}
                    <Pill tone="neutral">{m.tier}</Pill>
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    <code className="font-mono text-violet-300">{m.key}</code>
                    <span className="text-slate-600"> → </span>
                    {m.model_name}
                    <span className="text-slate-600"> · </span>
                    {(m.context_window / 1000).toFixed(0)}k context
                    <span className="text-slate-600"> · </span>
                    {m.api_key_set ? (
                      <span title="A key is stored on this model">
                        key ••••{m.api_key_hint}
                      </span>
                    ) : (
                      <span
                        className="text-amber-400/80"
                        title="No key on this model — it falls back to the backend's provider environment variable, so it will stop working if moved to a host without one"
                      >
                        key from .env
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-right text-xs text-slate-400">
                  <div>
                    in <span className="font-mono text-slate-300">${Number(m.input_cost_per_1m).toFixed(2)}</span>
                  </div>
                  <div>
                    out <span className="font-mono text-slate-300">${Number(m.output_cost_per_1m).toFixed(2)}</span>
                  </div>
                  <div className="text-slate-500">per 1M</div>
                </div>

                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    busy={testing === m.id}
                    onClick={() => handleTest(m.id)}
                    title="Send one real completion using this model's saved configuration"
                  >
                    {testing !== m.id && <TestTube2 className="h-3.5 w-3.5" />} Test
                  </Button>
                  <Button size="sm" onClick={() => run(() => updateModel(m.id, { is_active: !m.is_active }))}>
                    {m.is_active ? "Disable" : "Enable"}
                  </Button>
                  {!m.is_default && (
                    <Button
                      size="sm"
                      onClick={() => run(() => updateModel(m.id, { is_default: true }))}
                      title="Use this model when nothing more specific applies to a caller"
                    >
                      Make default
                    </Button>
                  )}
                  <IconButton
                    tone="danger"
                    onClick={() => run(() => deleteModel(m.id))}
                    title="Delete. Past usage keeps its recorded cost."
                    aria-label={`Delete ${m.display_name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>

                {testResult?.id === m.id && (
                  <p
                    className={`w-full text-xs ${testResult.ok ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {testResult.ok ? "✓" : "✗"} {testResult.message}
                  </p>
                )}
              </Row>
            ))
          )}
        </CardContent>
      </Card>

      {draft && (
        <ModelForm
          draft={draft}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() =>
            run(async () => {
              await createModel(draft as unknown as Partial<AdminModel>);
              setDraft(null);
            })
          }
        />
      )}

      <AccessSection models={models} policies={policies} teams={teams} users={users} onChange={run} />
    </div>
  );
}

// ── Model form ───────────────────────────────────────────────────────────────

function ModelForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value });
  const num = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...draft, [key]: Number(e.target.value) });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between p-4 pb-3">
        <CardTitle className="text-sm">New model</CardTitle>
        <IconButton onClick={onCancel} aria-label="Cancel">
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </CardHeader>
      <CardContent className="space-y-5 p-4 pt-0">
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Identity</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Key" hint="The slug agents and clients refer to, e.g. 'fast' or 'deep'.">
              <TextInput
                value={draft.model_key}
                onChange={(e) => set("model_key", e.target.value)}
                placeholder="deep"
              />
            </Field>
            <Field label="Display name" hint="What users see in the model picker.">
              <TextInput
                value={draft.display_name}
                onChange={(e) => set("display_name", e.target.value)}
                placeholder="GPT-4.1"
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Connection</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Deployment name" hint="The Azure deployment name, exactly as deployed.">
              <TextInput
                value={draft.model_name}
                onChange={(e) => set("model_name", e.target.value)}
                placeholder="gpt-4.1"
              />
            </Field>
            <Field label="Endpoint URL">
              <TextInput
                value={draft.endpoint_url}
                onChange={(e) => set("endpoint_url", e.target.value)}
                placeholder="https://your-resource.openai.azure.com"
              />
            </Field>
            <Field
              label="API key"
              hint="Stored on the model, so it works without a .env edit or a restart. Write-only — it is never sent back to this page. Leave blank to use the backend's provider environment variable."
            >
              <TextInput
                type="password"
                autoComplete="new-password"
                value={draft.api_key}
                onChange={(e) => set("api_key", e.target.value)}
                placeholder="Paste the provider key, or leave blank for .env"
              />
            </Field>
            <Field label="API version">
              <TextInput value={draft.api_version} onChange={(e) => set("api_version", e.target.value)} />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Capabilities</h3>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Context window" hint="Tokens. Sizes the agent's budget and the chat's context gauge.">
              <TextInput type="number" value={draft.context_window} onChange={num("context_window")} />
            </Field>
            <Field label="Max output tokens" hint="Per-turn ceiling for what the model generates.">
              <TextInput type="number" value={draft.max_output_tokens} onChange={num("max_output_tokens")} />
            </Field>
            <Field label="Tier" hint="Used when nominating a cheaper fallback for exhausted budgets.">
              <Dropdown value={draft.tier} onChange={(v) => set("tier", v)} options={TIER_OPTIONS} />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Pricing — USD per 1M tokens
          </h3>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Input">
              <TextInput type="number" step="0.01" value={draft.input_cost_per_1m} onChange={num("input_cost_per_1m")} />
            </Field>
            <Field
              label="Cached input"
              hint="Usually a fraction of the input rate. Long conversations are mostly cache hits, so this drives real cost."
            >
              <TextInput
                type="number"
                step="0.01"
                value={draft.cached_input_cost_per_1m}
                onChange={num("cached_input_cost_per_1m")}
              />
            </Field>
            <Field label="Output">
              <TextInput type="number" step="0.01" value={draft.output_cost_per_1m} onChange={num("output_cost_per_1m")} />
            </Field>
          </div>
        </section>

        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={draft.is_default}
            onChange={(e) => set("is_default", e.target.checked)}
            className="h-4 w-4 accent-violet-500"
          />
          Make this the default model (replaces the current default)
        </label>

        <div className="flex gap-2 border-t border-slate-800 pt-4">
          <Button
            tone="primary"
            onClick={onSave}
            disabled={!draft.model_key || !draft.model_name || !draft.display_name}
          >
            <Check className="h-4 w-4" /> Save model
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Access policies ──────────────────────────────────────────────────────────

function AccessSection({
  models,
  policies,
  teams,
  users,
  onChange,
}: {
  models: AdminModel[];
  policies: AccessPolicy[];
  teams: Team[];
  users: AdminUser[];
  onChange: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [subjectType, setSubjectType] = useState<SubjectType>("role");
  const [subjectRef, setSubjectRef] = useState("user");
  const [modelId, setModelId] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  const refOptions =
    subjectType === "team"
      ? teams.map((t) => ({ value: String(t.id), label: t.name }))
      : subjectType === "user"
        ? users.map((u) => ({ value: String(u.id), label: u.username, detail: u.email }))
        : subjectType === "role"
          ? [
              { value: "user", label: "user" },
              { value: "admin", label: "admin" },
            ]
          : [];

  return (
    <Card>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-violet-400" /> Who may use which model
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <Note tone="neutral">
          The most specific rule wins outright — <strong className="text-slate-300">user</strong> beats{" "}
          <strong className="text-slate-300">team</strong> beats <strong className="text-slate-300">role</strong>{" "}
          beats <strong className="text-slate-300">everyone</strong> — and it replaces the broader rule
          rather than adding to it. Someone no rule matches gets every active model.
        </Note>

        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Applies to">
            <Dropdown
              value={subjectType}
              onChange={(v) => {
                const next = v as SubjectType;
                setSubjectType(next);
                setSubjectRef(next === "global" ? "*" : next === "role" ? "user" : "");
              }}
              options={SUBJECT_OPTIONS}
            />
          </Field>

          <Field label="Which">
            <Dropdown
              value={subjectType === "global" ? "" : subjectRef}
              onChange={setSubjectRef}
              options={refOptions}
              disabled={subjectType === "global"}
              placeholder={subjectType === "global" ? "everyone" : "Select…"}
            />
          </Field>

          <Field label="Model">
            <Dropdown
              value={modelId}
              onChange={setModelId}
              options={models.map((m) => ({ value: String(m.id), label: m.display_name }))}
            />
          </Field>

          <div className="flex items-end gap-2">
            <label className="flex h-9 items-center gap-1.5 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="h-4 w-4 accent-violet-500"
              />
              their default
            </label>
            <Button
              tone="primary"
              disabled={!modelId || (subjectType !== "global" && !subjectRef)}
              onClick={() =>
                onChange(async () => {
                  await createPolicy({
                    subject_type: subjectType,
                    subject_ref: subjectType === "global" ? "*" : subjectRef,
                    model_config_id: Number(modelId),
                    is_default_for_subject: isDefault,
                  });
                  setModelId("");
                  setIsDefault(false);
                })
              }
            >
              <Plus className="h-4 w-4" /> Grant
            </Button>
          </div>
        </div>

        {policies.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No rules yet"
            hint="Everyone can use every active model. Add a rule above to narrow that."
          />
        ) : (
          <div className="space-y-1.5">
            {policies.map((p) => (
              <Row key={p.id} className="py-2">
                <Pill tone="neutral">
                  {p.subject_type === "global" ? "everyone" : `${p.subject_type}: ${labelFor(p, teams, users)}`}
                </Pill>
                <span className="text-slate-600">→</span>
                <span className="font-medium text-slate-100">{p.display_name}</span>
                {p.is_default_for_subject && <Pill tone="accent">default</Pill>}
                <IconButton
                  tone="danger"
                  className="ml-auto"
                  onClick={() => onChange(() => deletePolicy(p.id))}
                  aria-label="Remove rule"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </Row>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Turn a policy's opaque subject_ref (a role name, or an id as text) into
 *  something readable. Falls back to the raw ref when the team or user has
 *  since been deleted, which is more useful than showing nothing. */
function labelFor(p: AccessPolicy, teams: Team[], users: AdminUser[]): string {
  if (p.subject_type === "team") {
    return teams.find((t) => String(t.id) === p.subject_ref)?.name ?? p.subject_ref;
  }
  if (p.subject_type === "user") {
    return users.find((u) => String(u.id) === p.subject_ref)?.username ?? p.subject_ref;
  }
  return p.subject_ref;
}
