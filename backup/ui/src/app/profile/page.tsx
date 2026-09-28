"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/auth";
import {
  User,
  ShieldCheck,
  Users,
  FolderGit2,
  Archive,
  MessageSquare,
  CheckCircle2,
  Clock,
  BarChart3,
  Calendar,
  Mail,
  Coins,
  LogIn,
  Layers,
  Loader2,
  AlertCircle,
  Zap,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/story-builder/page-header";
import { cn } from "@/lib/utils";
import { useProfile } from "@/hooks/useDbProjects";
import { ChangePasswordCard } from "@/components/shared/ChangePasswordCard";

// ── helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Compact token counts — 1.2M reads better than 1,234,567 in a tile. */
function formatCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

function formatUsd(amount: number) {
  if (amount === 0) return "$0.00";
  // Sub-cent spend is real but rounds to $0.00, which reads as "nothing used".
  if (amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

function roleLabel(name: string) {
  const map: Record<string, string> = {
    workspace_studio: "Workspace Studio",
  };
  return map[name] ?? name.replace(/_/g, " ");
}

// ── Avatar initials ───────────────────────────────────────────────────────────
function Avatar({ name, isAdmin }: { name: string; isAdmin: boolean }) {
  const initials = name
    .split(/[\s._-]/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div
      className={cn(
        "flex h-20 w-20 items-center justify-center rounded-full border-2 text-2xl font-bold shrink-0",
        isAdmin
          ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
          : "border-indigo-500/50 bg-indigo-500/10 text-indigo-300"
      )}
    >
      {initials || <User className="h-8 w-8" />}
    </div>
  );
}

// ── Single stat tile ──────────────────────────────────────────────────────────
function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  color = "slate",
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  color?: "slate" | "emerald" | "red" | "indigo" | "amber" | "cyan";
}) {
  const colorMap: Record<string, string> = {
    slate:   "text-slate-300 bg-slate-800/60 border-slate-700",
    emerald: "text-emerald-300 bg-emerald-950/30 border-emerald-800/60",
    red:     "text-red-300 bg-red-950/30 border-red-800/60",
    indigo:  "text-indigo-300 bg-indigo-950/30 border-indigo-700/60",
    amber:   "text-amber-300 bg-amber-950/30 border-amber-700/60",
    cyan:    "text-cyan-300 bg-cyan-950/30 border-cyan-700/60",
  };
  const iconColorMap: Record<string, string> = {
    slate:   "text-slate-500",
    emerald: "text-emerald-400",
    red:     "text-red-400",
    indigo:  "text-indigo-400",
    amber:   "text-amber-400",
    cyan:    "text-cyan-400",
  };
  return (
    <div className={cn("rounded-xl border p-4", colorMap[color])}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
        <Icon className={cn("h-4 w-4", iconColorMap[color])} />
      </div>
      <p className="text-2xl font-bold leading-none">{value}</p>
      {sub && <p className="text-[11px] text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const router = useRouter();
  const { data: profile, isLoading: loading, error: queryError } = useProfile();
  const error = queryError ? (queryError instanceof Error ? queryError.message : "Failed to load profile") : null;

  useEffect(() => {
    const user = getUser();
    if (!user) { router.replace("/login"); }
  }, [router]);

  if (loading) {
    return (
      <div className="flex h-60 items-center justify-center text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading profile…
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="flex h-60 items-center justify-center gap-2 text-red-400">
        <AlertCircle className="h-5 w-5" /> {error ?? "Profile unavailable"}
      </div>
    );
  }

  const { user, teams, roles, stats } = profile;

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Profile"
        description="Your account details, teams, and activity summary."
      />

      {/* ── Identity card ─────────────────────────────────────── */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
            <Avatar name={user.full_name || user.username} isAdmin={user.is_admin} />

            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-bold text-slate-100">
                  {user.full_name || user.username}
                </h2>
                {user.is_admin ? (
                  <Badge className="bg-amber-500/15 text-amber-400 border border-amber-600/30 gap-1">
                    <ShieldCheck className="h-3 w-3" /> Admin
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-slate-400">User</Badge>
                )}
              </div>

              {user.full_name && (
                <p className="text-sm text-slate-400 font-mono">@{user.username}</p>
              )}

              <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                {user.email && (
                  <span className="flex items-center gap-1">
                    <Mail className="h-3.5 w-3.5" /> {user.email}
                  </span>
                )}
                {user.created_at && (
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3.5 w-3.5" /> Member since {formatDate(user.created_at)}
                  </span>
                )}
                {user.last_login && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> Last login {formatDate(user.last_login)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Stats grid ────────────────────────────────────────── */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-1.5">
          <BarChart3 className="h-3.5 w-3.5" /> Activity Overview
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatTile
            icon={FolderGit2}
            label="Active Workspaces"
            value={stats.active_workspaces}
            color="indigo"
          />
          <StatTile
            icon={Archive}
            label="Archived"
            value={stats.archived_workspaces}
            color="slate"
          />
          <StatTile
            icon={Layers}
            label="Sessions"
            value={stats.total_sessions}
            sub={stats.active_sessions > 0 ? `${stats.active_sessions} active now` : undefined}
            color="cyan"
          />
          <StatTile
            icon={MessageSquare}
            label="Prompts Sent"
            value={formatCount(stats.prompts_sent)}
            color="emerald"
          />
          <StatTile
            icon={Zap}
            label="Model Requests"
            value={formatCount(stats.llm_requests)}
            color="amber"
          />
          <StatTile
            icon={Coins}
            label="Tokens Used"
            value={formatCount(stats.total_tokens)}
            sub={`${formatCount(stats.tokens_this_month)} this month`}
            color="indigo"
          />
          <StatTile
            icon={LogIn}
            label="Sign-ins"
            value={formatCount(stats.login_count)}
            color="slate"
          />
          <StatTile
            icon={Calendar}
            label="Last Active"
            value={formatDate(stats.last_active_at)}
            sub={`${formatUsd(stats.cost_this_month_usd)} spent this month`}
            color="slate"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Teams ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-indigo-400" /> Teams
            </CardTitle>
          </CardHeader>
          <CardContent>
            {teams.length === 0 ? (
              <p className="text-xs text-slate-500 italic">
                Not a member of any team. Teams set model access and token budgets;
                without one you fall back to the global policy.
              </p>
            ) : (
              <ul className="space-y-2">
                {teams.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2.5"
                  >
                    <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600/20 text-indigo-400 shrink-0">
                      <Users className="h-3 w-3" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-slate-200">{t.name}</p>
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          {t.role_in_team}
                        </span>
                      </div>
                      {t.description && (
                        <p className="text-xs text-slate-500 truncate">{t.description}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ── Roles ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-indigo-400" /> Permissions
            </CardTitle>
          </CardHeader>
          <CardContent>
            {user.is_admin ? (
              <div className="flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2.5">
                <ShieldCheck className="h-4 w-4 text-amber-400 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-300">Full Administrator Access</p>
                  <p className="text-xs text-slate-500">All permissions granted via admin role</p>
                </div>
              </div>
            ) : roles.length === 0 ? (
              <p className="text-xs text-slate-500 italic">No capabilities granted.</p>
            ) : (
              <ul className="space-y-2">
                {roles.map((r) => (
                  <li
                    key={r}
                    className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    <span className="text-sm text-slate-200">{roleLabel(r)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Account security */}
        <ChangePasswordCard />
      </div>
    </div>
  );
}
