"use client";

/**
 * /admin/teams — grouping for model access and budgets.
 *
 * Teams here are ONLY a subject for policies and quotas. They are deliberately
 * not an ownership or sharing boundary: a workspace still belongs to exactly
 * one user (see db/README.md), and adding a second ownership axis would
 * quietly undermine the isolation every read and write path depends on.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2, UserPlus, Users } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/story-builder/page-header";
import {
  Button,
  Dropdown,
  EmptyState,
  ErrorBanner,
  IconButton,
  Loading,
  Note,
  Pill,
  Row,
  TextInput,
} from "@/components/admin/AdminUI";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  fetchAdminUsers,
  fetchTeamMembers,
  fetchTeams,
  removeTeamMember,
  type AdminUser,
  type Team,
  type TeamMember,
} from "@/lib/devsphere-models-api";

export default function AdminTeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [members, setMembers] = useState<Record<number, TeamMember[]>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [t, u] = await Promise.all([fetchTeams(), fetchAdminUsers()]);
    setTeams(t);
    setUsers(u);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchTeams(), fetchAdminUsers()]).then(([t, u]) => {
      if (cancelled) return;
      setTeams(t);
      setUsers(u);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMembers = async (id: number) => {
    const list = await fetchTeamMembers(id);
    setMembers((prev) => ({ ...prev, [id]: list }));
  };

  const toggleTeam = async (id: number) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    // Loaded on demand rather than eagerly for every team: an install with
    // fifty teams would otherwise fire fifty requests to render a list nobody
    // has opened yet.
    await loadMembers(id);
  };

  const run = async (fn: () => Promise<unknown>, teamId?: number) => {
    setError(null);
    try {
      await fn();
      await reload();
      if (teamId != null) await loadMembers(teamId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const createFromInput = () =>
    run(async () => {
      await createTeam({ name: newName.trim() });
      setNewName("");
    });

  if (loading) return <Loading label="Loading teams…" />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Teams"
        description="Group people so model access and token budgets can be set once instead of per person."
      />

      {error && <ErrorBanner message={error} />}

      <Note tone="neutral">
        Teams affect model access and budgets only. Workspaces still belong to exactly one
        user — joining a team never shares anyone&apos;s workspace.
      </Note>

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Plus className="h-4 w-4 text-violet-400" /> New team
          </CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2 p-4 pt-0">
          <TextInput
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) void createFromInput();
            }}
            placeholder="Platform Engineering"
          />
          <Button tone="primary" disabled={!newName.trim()} onClick={createFromInput}>
            <Plus className="h-4 w-4" /> Create
          </Button>
        </CardContent>
      </Card>

      {teams.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No teams yet"
          hint="Create one above, then grant it models on the Models page and a budget on Budgets."
        />
      ) : (
        <div className="space-y-2">
          {teams.map((t) => {
            const isOpen = expanded === t.id;
            const teamMembers = members[t.id] ?? [];
            const addable = users.filter((u) => !teamMembers.some((m) => m.id === u.id));

            return (
              <Card key={t.id} className="overflow-hidden">
                <div className="flex items-center gap-2 p-3">
                  <button
                    type="button"
                    onClick={() => toggleTeam(t.id)}
                    className="flex flex-1 items-center gap-2 text-left text-sm font-medium text-slate-100 transition-colors hover:text-violet-300"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 text-slate-500" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-slate-500" />
                    )}
                    <Users className="h-4 w-4 text-violet-400" />
                    {t.name}
                    <Pill tone="neutral">
                      {t.member_count} member{t.member_count === 1 ? "" : "s"}
                    </Pill>
                  </button>
                  <IconButton
                    tone="danger"
                    onClick={() => run(() => deleteTeam(t.id))}
                    title="Delete team. Its model grants and budget go with it."
                    aria-label={`Delete ${t.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>

                {isOpen && (
                  <CardContent className="space-y-2 border-t border-slate-800 bg-slate-950/40 p-3">
                    <div className="flex items-center gap-2">
                      <UserPlus className="h-4 w-4 shrink-0 text-slate-500" />
                      <div className="max-w-xs flex-1">
                        <Dropdown
                          value=""
                          placeholder={addable.length ? "Add a member…" : "Everyone is already a member"}
                          disabled={addable.length === 0}
                          onChange={(v) => run(() => addTeamMember(t.id, Number(v)), t.id)}
                          options={addable.map((u) => ({
                            value: String(u.id),
                            label: u.username,
                            detail: u.email,
                          }))}
                        />
                      </div>
                    </div>

                    {teamMembers.length === 0 ? (
                      <p className="py-2 text-sm text-slate-500">No members yet.</p>
                    ) : (
                      teamMembers.map((m) => (
                        <Row key={m.id} className="py-2">
                          <span className="font-medium text-slate-100">{m.username}</span>
                          <span className="text-xs text-slate-500">{m.email}</span>
                          <Pill tone="neutral">{m.role_in_team}</Pill>
                          <IconButton
                            tone="danger"
                            className="ml-auto"
                            onClick={() => run(() => removeTeamMember(t.id, m.id), t.id)}
                            aria-label={`Remove ${m.username}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </IconButton>
                        </Row>
                      ))
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
