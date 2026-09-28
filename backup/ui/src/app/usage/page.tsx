"use client";

/**
 * /usage — "how much have I used, and how much is left?"
 *
 * The one page that answers the question the chat's per-message badges can
 * only answer one turn at a time. Deliberately shows the SAME numbers the
 * backend enforces on (they come from `quota.status_for_user`, the function
 * `quota.check` calls) — a usage page computing its own totals would drift
 * from the limits actually being applied, and the user would be told they
 * have room they don't have.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, BarChart3, Coins, Cpu, Gauge, Info, Zap } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/story-builder/page-header";
import { EmptyState, Loading, Note, Table, Td, Th } from "@/components/admin/AdminUI";
import {
  fetchMyUsage,
  formatCost,
  formatTokens,
  type MyUsage,
  type UsageWindow,
} from "@/lib/devsphere-models-api";

function toneFor(pct: number | null, warnPct: number | null, criticalPct: number | null) {
  if (pct == null) return { bar: "bg-violet-500", text: "text-slate-100" };
  if (pct >= 100) return { bar: "bg-red-500", text: "text-red-400" };
  if (criticalPct != null && pct >= criticalPct) return { bar: "bg-amber-500", text: "text-amber-400" };
  if (warnPct != null && pct >= warnPct) return { bar: "bg-amber-400", text: "text-amber-300" };
  return { bar: "bg-violet-500", text: "text-slate-100" };
}

function WindowCard({
  title,
  subtitle,
  data,
  warnPct,
  criticalPct,
}: {
  title: string;
  subtitle: string;
  data: UsageWindow;
  warnPct: number | null;
  criticalPct: number | null;
}) {
  const tone = toneFor(data.pct, warnPct, criticalPct);
  // Cache hit rate is the single biggest lever on cost in a long conversation,
  // so it gets equal billing with the raw totals rather than hiding in a tooltip.
  const cachedPct =
    data.prompt_tokens > 0 ? Math.round((data.cached_tokens / data.prompt_tokens) * 100) : 0;

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Gauge className="h-4 w-4 text-violet-400" />
          {title}
          <span className="ml-auto text-xs font-normal text-slate-500">{subtitle}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <div className="flex items-baseline gap-2">
          <span className={`font-mono text-3xl font-semibold tabular-nums ${tone.text}`}>
            {formatTokens(data.used)}
          </span>
          <span className="text-sm text-slate-400">
            {data.limit != null ? `of ${formatTokens(data.limit)} tokens` : "tokens · no limit set"}
          </span>
        </div>

        {data.limit != null && (
          <div className="space-y-1.5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${tone.bar}`}
                style={{ width: `${Math.min(data.pct ?? 0, 100)}%` }}
              />
            </div>
            <p className="text-xs text-slate-400">
              {(data.pct ?? 0).toFixed(0)}% used ·{" "}
              <span className="font-mono">{formatTokens(Math.max(0, data.limit - data.used))}</span> left
            </p>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-slate-800 pt-3 text-xs">
          <dt className="text-slate-400">Input</dt>
          <dd className="text-right font-mono tabular-nums text-slate-200">
            {formatTokens(data.prompt_tokens)}
          </dd>
          <dt className="text-slate-400">Output</dt>
          <dd className="text-right font-mono tabular-nums text-slate-200">
            {formatTokens(data.completion_tokens)}
          </dd>
          <dt
            className="text-slate-400"
            title="Input served from the provider's cache, billed at a fraction of the fresh rate"
          >
            Cached input
          </dt>
          <dd className="text-right font-mono tabular-nums text-slate-200">
            {formatTokens(data.cached_tokens)}
            {cachedPct > 0 && <span className="ml-1 text-slate-500">({cachedPct}%)</span>}
          </dd>
          <dt className="text-slate-400">Requests</dt>
          <dd className="text-right font-mono tabular-nums text-slate-200">
            {data.request_count.toLocaleString()}
          </dd>
          <dt className="text-slate-400">Cost</dt>
          <dd className="text-right font-mono tabular-nums text-slate-200">{formatCost(data.cost_usd)}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}

export default function UsagePage() {
  const [usage, setUsage] = useState<MyUsage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchMyUsage(30).then((data) => {
      if (cancelled) return;
      setUsage(data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="p-6"><Loading label="Loading usage…" /></div>;

  if (!usage) {
    return (
      <div className="space-y-5 p-6">
        <PageHeader title="Token Usage" description="Your model spend and budget." />
        <Note tone="warn">
          Usage data isn&apos;t available. If this persists, the token governance migration may not
          have been applied yet.
        </Note>
      </div>
    );
  }

  const { quota, by_model: byModel, daily } = usage;
  const peakDay = daily.reduce((max, d) => Math.max(max, d.total_tokens), 0);

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Token Usage"
        description="What you've spent on models, and how much of your budget is left."
      />

      {quota.has_quota && quota.level !== "ok" && (
        <p
          className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${
            quota.level === "blocked"
              ? "border-red-500/40 bg-red-500/10 text-red-300"
              : quota.level === "exceeded"
                ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
                : "border-amber-500/40 bg-amber-500/10 text-amber-300"
          }`}
        >
          {quota.level === "exceeded" ? (
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          {quota.message}
        </p>
      )}

      {!quota.has_quota && (
        <Note tone="neutral">
          No budget applies to your account — usage is tracked but not limited.
        </Note>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <WindowCard
          title="Today"
          subtitle="resets at midnight"
          data={quota.day}
          warnPct={quota.warn_pct}
          criticalPct={quota.critical_pct}
        />
        <WindowCard
          title="This month"
          subtitle="resets on the 1st"
          data={quota.month}
          warnPct={quota.warn_pct}
          criticalPct={quota.critical_pct}
        />
      </div>

      {quota.per_run_limit != null && (
        <p className="flex items-start gap-1.5 text-xs text-slate-400">
          <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-400" />
          A single agent run stops after {formatTokens(quota.per_run_limit)} tokens and asks you to
          continue — so one runaway loop can&apos;t spend the whole budget.
        </p>
      )}

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Cpu className="h-4 w-4 text-violet-400" /> By model, this month
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {byModel.length === 0 ? (
            <EmptyState icon={Cpu} title="No usage recorded this month" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Model</Th>
                  <Th right>Input</Th>
                  <Th right>Output</Th>
                  <Th right>Cached</Th>
                  <Th right>Requests</Th>
                  <Th right>Cost</Th>
                </tr>
              </thead>
              <tbody>
                {byModel.map((row) => (
                  <tr key={row.model} className="transition-colors hover:bg-slate-800/40">
                    <Td>
                      <span className="font-mono text-xs text-slate-100">{row.model}</span>
                    </Td>
                    <Td right mono>{formatTokens(row.prompt_tokens)}</Td>
                    <Td right mono>{formatTokens(row.completion_tokens)}</Td>
                    <Td right mono dim>{formatTokens(row.cached_tokens)}</Td>
                    <Td right mono>{row.request_count.toLocaleString()}</Td>
                    <Td right mono>{formatCost(row.cost_usd)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="h-4 w-4 text-violet-400" /> Last 30 days
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {daily.length === 0 ? (
            <EmptyState icon={BarChart3} title="No usage in the last 30 days" />
          ) : (
            // Bars are scaled to the PEAK day, not to the quota: this chart is
            // about the shape of usage over time, and the gauges above already
            // answer "how close am I to the limit".
            <div className="flex h-32 items-end gap-1">
              {daily.map((d) => (
                <div
                  key={d.date}
                  className="flex-1 rounded-t bg-violet-500/50 transition-colors hover:bg-violet-400"
                  style={{ height: `${peakDay ? Math.max((d.total_tokens / peakDay) * 100, 2) : 2}%` }}
                  title={`${d.date}: ${formatTokens(d.total_tokens)} tokens · ${formatCost(d.cost_usd)} · ${d.request_count} requests`}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="flex items-start gap-1.5 text-xs text-slate-500">
        <Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Cached input is billed at a fraction of fresh input, so a long conversation usually costs
        far less than its token count suggests. Cost is calculated from the rates an admin set on
        each model.
      </p>
    </div>
  );
}
