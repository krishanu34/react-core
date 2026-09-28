"use client";

/**
 * /admin/usage — where the tokens are going, across the whole install.
 *
 * Three cuts of the same ledger. The team totals sum to MORE than the user
 * totals when anyone belongs to two teams: they are counted in both. That is
 * deliberate — the alternative is splitting one person's spend across their
 * teams, which makes every team's number quietly wrong instead of obviously
 * overlapping.
 */

import { useEffect, useState } from "react";
import { BarChart3, Coins, Cpu, Database, Users } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/story-builder/page-header";
import {
  EmptyState,
  Loading,
  Note,
  Pill,
  Table,
  Td,
  Th,
} from "@/components/admin/AdminUI";
import {
  fetchAdminUsage,
  formatCost,
  formatTokens,
  type AdminUsage,
} from "@/lib/devsphere-models-api";

const WINDOWS = [
  { value: "day", label: "Today" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="flex items-center gap-1.5 text-xs text-slate-400" title={hint}>
          <Icon className="h-3.5 w-3.5 text-violet-400" />
          {label}
        </p>
        <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-slate-100">{value}</p>
      </CardContent>
    </Card>
  );
}

export default function AdminUsagePage() {
  const [window, setWindow] = useState("month");
  // The loaded window travels WITH the data rather than in a separate
  // `loading` flag: that way switching windows can't briefly show the previous
  // window's numbers under the new window's heading.
  const [loaded, setLoaded] = useState<{ window: string; usage: AdminUsage | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAdminUsage(window).then((data) => {
      if (!cancelled) setLoaded({ window, usage: data });
    });
    return () => {
      cancelled = true;
    };
  }, [window]);

  const loading = loaded?.window !== window;
  const usage = loading ? null : (loaded?.usage ?? null);

  const sum = (pick: (r: AdminUsage["by_user"][number]) => number) =>
    usage?.by_user.reduce((acc, r) => acc + pick(r), 0) ?? 0;
  const totalTokens = sum((r) => r.total_tokens);
  const totalCost = sum((r) => r.cost_usd);
  const totalCached = sum((r) => r.cached_tokens);
  const totalPrompt = sum((r) => r.prompt_tokens);

  return (
    <div className="space-y-5">
      <PageHeader title="Usage" description="Token spend by person, team and model." />

      <div className="flex gap-1.5">
        {WINDOWS.map((w) => (
          <button
            key={w.value}
            type="button"
            onClick={() => setWindow(w.value)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              window === w.value
                ? "bg-violet-600 text-white"
                : "border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white"
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {loading ? (
        <Loading label="Loading usage…" />
      ) : !usage ? (
        <Note tone="warn">
          Usage data isn&apos;t available — the token governance migration may not have been applied.
        </Note>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard icon={Coins} label="Total tokens" value={formatTokens(totalTokens)} />
            <StatCard icon={Database} label="Cost" value={formatCost(totalCost)} />
            <StatCard
              icon={BarChart3}
              label="Cache hit rate"
              hint="Share of input tokens served from the provider's cache — billed at a fraction of the fresh rate"
              value={totalPrompt > 0 ? `${Math.round((totalCached / totalPrompt) * 100)}%` : "—"}
            />
          </div>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BarChart3 className="h-4 w-4 text-violet-400" /> By user
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              {usage.by_user.length === 0 ? (
                <EmptyState icon={BarChart3} title="No usage recorded in this window" />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>User</Th>
                      <Th>Role</Th>
                      <Th right>Input</Th>
                      <Th right>Output</Th>
                      <Th right>Cached</Th>
                      <Th right>Requests</Th>
                      <Th right>Cost</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.by_user.map((r) => (
                      <tr key={r.user_id} className="transition-colors hover:bg-slate-800/40">
                        <Td>
                          <span className="font-medium text-slate-100">{r.username}</span>
                          <span className="ml-2 text-xs text-slate-500">{r.email}</span>
                        </Td>
                        <Td>
                          <Pill tone={r.role === "admin" ? "accent" : "neutral"}>{r.role}</Pill>
                        </Td>
                        <Td right mono>{formatTokens(r.prompt_tokens)}</Td>
                        <Td right mono>{formatTokens(r.completion_tokens)}</Td>
                        <Td right mono dim>{formatTokens(r.cached_tokens)}</Td>
                        <Td right mono>{r.request_count.toLocaleString()}</Td>
                        <Td right mono>{formatCost(r.cost_usd)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="p-4 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Users className="h-4 w-4 text-violet-400" /> By team
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 p-4 pt-0">
                {usage.by_team.length === 0 ? (
                  <EmptyState icon={Users} title="No teams configured" />
                ) : (
                  <>
                    <Table>
                      <thead>
                        <tr>
                          <Th>Team</Th>
                          <Th right>Members</Th>
                          <Th right>Tokens</Th>
                          <Th right>Cost</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {usage.by_team.map((r) => (
                          <tr key={r.team_id} className="transition-colors hover:bg-slate-800/40">
                            <Td>
                              <span className="font-medium text-slate-100">{r.name}</span>
                            </Td>
                            <Td right mono>{r.member_count}</Td>
                            <Td right mono>{formatTokens(r.total_tokens)}</Td>
                            <Td right mono>{formatCost(r.cost_usd)}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                    <p className="text-[11px] text-slate-500">
                      Someone in two teams counts toward both, so these totals can exceed the
                      per-user figures above.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="p-4 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Cpu className="h-4 w-4 text-violet-400" /> By model
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                {usage.by_model.length === 0 ? (
                  <EmptyState icon={Cpu} title="No usage recorded" />
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Model</Th>
                        <Th right>Tokens</Th>
                        <Th right>Requests</Th>
                        <Th right>Cost</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.by_model.map((r) => (
                        <tr key={r.model} className="transition-colors hover:bg-slate-800/40">
                          <Td>
                            <span className="font-mono text-xs text-slate-100">{r.model}</span>
                          </Td>
                          <Td right mono>{formatTokens(r.total_tokens)}</Td>
                          <Td right mono>{r.request_count.toLocaleString()}</Td>
                          <Td right mono>{formatCost(r.cost_usd)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
