"use client";

/**
 * /admin/quotas — token budgets.
 *
 * The important thing this page has to communicate is what happens at 100%,
 * because it is not what people assume. Reaching a limit does NOT stop work:
 * the run continues on the cheaper model nominated below. A developer halted
 * mid-task loses the task, not just the tokens, and a budget exists to cap
 * cost — which a cheaper model does without throwing work away.
 *
 * Hard stops are still available, and are opt-in in two ways: leave the
 * fallback model unset, or set an absolute ceiling.
 */

import { useCallback, useEffect, useState } from "react";
import { Gauge, Plus, Trash2 } from "lucide-react";

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
  deleteQuota,
  fetchAdminModels,
  fetchAdminUsers,
  fetchQuotas,
  fetchTeams,
  formatTokens,
  upsertQuota,
  type AdminModel,
  type AdminUser,
  type Quota,
  type SubjectType,
  type Team,
} from "@/lib/devsphere-models-api";

interface Draft {
  subject_type: SubjectType;
  subject_ref: string;
  daily_token_limit: string;
  monthly_token_limit: string;
  per_run_token_limit: string;
  warn_pct: string;
  critical_pct: string;
  degrade_model_config_id: string;
  hard_block_tokens: string;
}

const EMPTY: Draft = {
  subject_type: "role",
  subject_ref: "user",
  daily_token_limit: "",
  monthly_token_limit: "",
  per_run_token_limit: "",
  warn_pct: "75",
  critical_pct: "90",
  degrade_model_config_id: "",
  hard_block_tokens: "",
};

const SUBJECT_OPTIONS = [
  { value: "global", label: "Everyone" },
  { value: "role", label: "Role" },
  { value: "team", label: "Team" },
  { value: "user", label: "User" },
];

/** "" means "no limit on this axis", which is different from 0. */
const num = (v: string) => (v.trim() === "" ? null : Number(v));

/** Radix can't hold "" as a real value, so the "no fallback" choice needs a
 *  sentinel of its own rather than an empty option. */
const NO_DEGRADE = "__none__";

export default function AdminQuotasPage() {
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [q, m, t, u] = await Promise.all([
      fetchQuotas(),
      fetchAdminModels(),
      fetchTeams(),
      fetchAdminUsers(),
    ]);
    setQuotas(q);
    setModels(m);
    setTeams(t);
    setUsers(u);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchQuotas(), fetchAdminModels(), fetchTeams(), fetchAdminUsers()]).then(
      ([q, m, t, u]) => {
        if (cancelled) return;
        setQuotas(q);
        setModels(m);
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

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });

  const refOptions =
    draft.subject_type === "team"
      ? teams.map((t) => ({ value: String(t.id), label: t.name }))
      : draft.subject_type === "user"
        ? users.map((u) => ({ value: String(u.id), label: u.username, detail: u.email }))
        : draft.subject_type === "role"
          ? [
              { value: "user", label: "user" },
              { value: "admin", label: "admin" },
            ]
          : [];

  if (loading) return <Loading label="Loading budgets…" />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Token budgets"
        description="How much each person, team or role may spend — and what happens when they reach it."
      />

      {error && <ErrorBanner message={error} />}

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Plus className="h-4 w-4 text-violet-400" /> Set a budget
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5 p-4 pt-0">
          <Note tone="neutral">
            The most specific active budget wins outright — <strong className="text-slate-300">user</strong>{" "}
            over <strong className="text-slate-300">team</strong> over{" "}
            <strong className="text-slate-300">role</strong> over{" "}
            <strong className="text-slate-300">everyone</strong>. It replaces the broader one rather
            than stacking with it. Saving over an existing budget for the same subject replaces it.
          </Note>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Who</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Applies to">
                <Dropdown
                  value={draft.subject_type}
                  onChange={(v) => {
                    const next = v as SubjectType;
                    setDraft({
                      ...draft,
                      subject_type: next,
                      subject_ref: next === "global" ? "*" : next === "role" ? "user" : "",
                    });
                  }}
                  options={SUBJECT_OPTIONS}
                />
              </Field>
              <Field label="Which">
                <Dropdown
                  value={draft.subject_type === "global" ? "" : draft.subject_ref}
                  onChange={(v) => set("subject_ref", v)}
                  options={refOptions}
                  disabled={draft.subject_type === "global"}
                  placeholder={draft.subject_type === "global" ? "everyone" : "Select…"}
                />
              </Field>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Limits — leave blank for none
            </h3>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Daily" hint="Resets at midnight.">
                <TextInput
                  inputMode="numeric"
                  value={draft.daily_token_limit}
                  onChange={(e) => set("daily_token_limit", e.target.value)}
                  placeholder="e.g. 500000"
                />
              </Field>
              <Field label="Monthly" hint="Resets on the 1st.">
                <TextInput
                  inputMode="numeric"
                  value={draft.monthly_token_limit}
                  onChange={(e) => set("monthly_token_limit", e.target.value)}
                  placeholder="e.g. 10000000"
                />
              </Field>
              <Field label="Per run" hint="Stops one runaway agent loop from spending the month.">
                <TextInput
                  inputMode="numeric"
                  value={draft.per_run_token_limit}
                  onChange={(e) => set("per_run_token_limit", e.target.value)}
                  placeholder="e.g. 200000"
                />
              </Field>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              What happens as it fills
            </h3>
            <div className="grid gap-4 md:grid-cols-4">
              <Field label="Warn at %">
                <TextInput
                  inputMode="numeric"
                  value={draft.warn_pct}
                  onChange={(e) => set("warn_pct", e.target.value)}
                />
              </Field>
              <Field label="Critical at %">
                <TextInput
                  inputMode="numeric"
                  value={draft.critical_pct}
                  onChange={(e) => set("critical_pct", e.target.value)}
                />
              </Field>
              <Field label="At 100%, fall back to">
                <Dropdown
                  value={draft.degrade_model_config_id || NO_DEGRADE}
                  onChange={(v) => set("degrade_model_config_id", v === NO_DEGRADE ? "" : v)}
                  options={[
                    { value: NO_DEGRADE, label: "Nothing — refuse the run" },
                    ...models.map((m) => ({ value: String(m.id), label: m.display_name })),
                  ]}
                />
              </Field>
              <Field label="Absolute ceiling" hint="Even the fallback model stops here.">
                <TextInput
                  inputMode="numeric"
                  value={draft.hard_block_tokens}
                  onChange={(e) => set("hard_block_tokens", e.target.value)}
                  placeholder="blank = never"
                />
              </Field>
            </div>
          </section>

          <Note tone="info">
            At 100% the run <strong>keeps going on the fallback model</strong> — work is never
            interrupted, only made cheaper. To stop runs outright instead, leave the fallback as
            &ldquo;Nothing&rdquo; or set an absolute ceiling.
          </Note>

          <div className="border-t border-slate-800 pt-4">
            <Button
              tone="primary"
              disabled={draft.subject_type !== "global" && !draft.subject_ref}
              onClick={() =>
                run(async () => {
                  await upsertQuota({
                    subject_type: draft.subject_type,
                    subject_ref: draft.subject_type === "global" ? "*" : draft.subject_ref,
                    daily_token_limit: num(draft.daily_token_limit),
                    monthly_token_limit: num(draft.monthly_token_limit),
                    per_run_token_limit: num(draft.per_run_token_limit),
                    warn_pct: Number(draft.warn_pct) || 75,
                    critical_pct: Number(draft.critical_pct) || 90,
                    degrade_model_config_id: num(draft.degrade_model_config_id),
                    hard_block_tokens: num(draft.hard_block_tokens),
                    is_active: true,
                  });
                  setDraft(EMPTY);
                })
              }
            >
              <Plus className="h-4 w-4" /> Save budget
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Gauge className="h-4 w-4 text-violet-400" /> Active budgets
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 p-4 pt-0">
          {quotas.length === 0 ? (
            <EmptyState icon={Gauge} title="No budgets configured" hint="Nothing is limited yet." />
          ) : (
            quotas.map((q) => (
              <Row key={q.id}>
                <Pill tone="accent">
                  {q.subject_type === "global"
                    ? "everyone"
                    : `${q.subject_type}: ${quotaLabel(q, teams, users)}`}
                </Pill>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                  <span>
                    {q.daily_token_limit ? (
                      <>
                        <span className="font-mono text-slate-200">{formatTokens(q.daily_token_limit)}</span>/day
                      </>
                    ) : (
                      "no daily limit"
                    )}
                  </span>
                  <span className="text-slate-700">·</span>
                  <span>
                    {q.monthly_token_limit ? (
                      <>
                        <span className="font-mono text-slate-200">{formatTokens(q.monthly_token_limit)}</span>/month
                      </>
                    ) : (
                      "no monthly limit"
                    )}
                  </span>
                  {q.per_run_token_limit && (
                    <>
                      <span className="text-slate-700">·</span>
                      <span>
                        <span className="font-mono text-slate-200">{formatTokens(q.per_run_token_limit)}</span>/run
                      </span>
                    </>
                  )}
                  <span className="text-slate-700">·</span>
                  <span>
                    warn {q.warn_pct}% / critical {q.critical_pct}%
                  </span>
                </div>

                {q.degrade_model_name ? (
                  <Pill tone="info">falls back to {q.degrade_model_name}</Pill>
                ) : (
                  <Pill tone="warn">refuses runs at the limit</Pill>
                )}
                {q.hard_block_tokens && (
                  <Pill tone="bad">hard stop at {formatTokens(q.hard_block_tokens)}</Pill>
                )}

                <IconButton
                  tone="danger"
                  className="ml-auto"
                  onClick={() => run(() => deleteQuota(q.id))}
                  aria-label="Delete budget"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </Row>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function quotaLabel(q: Quota, teams: Team[], users: AdminUser[]): string {
  if (q.subject_type === "team") {
    return teams.find((t) => String(t.id) === q.subject_ref)?.name ?? q.subject_ref;
  }
  if (q.subject_type === "user") {
    return users.find((u) => String(u.id) === q.subject_ref)?.username ?? q.subject_ref;
  }
  return q.subject_ref;
}
