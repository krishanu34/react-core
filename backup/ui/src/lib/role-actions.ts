/**
 * Role → Quick-Action configuration.
 *
 * This is the single source of truth that maps database role names
 * to the UI actions a user may perform.  Admin users bypass all checks
 * and see every action.
 *
 * To add a new action:
 *   1. Add the role to the DB  (002_roles_tables.sql / admin UI)
 *   2. Add an entry here       (ROLE_ACTION_REGISTRY)
 *   3. Done — the overview page picks it up automatically.
 */

/* ── Action definition ─────────────────────────────────────────── */

export interface RoleAction {
  /** Unique key (used as React key). */
  key: string;
  /** Button label shown in the UI. */
  label: string;
  /** Lucide icon name (resolved at render time). */
  icon: string;
  /**
   * Href template.  Use `{projectId}` as a placeholder — the
   * consumer replaces it at render time.
   */
  href: string;
  /**
   * One or more DB role names.  The action is shown when the user
   * holds **any** of these roles (OR logic).  Admin users skip this
   * check entirely.
   */
  roles: string[];
  /** Lower numbers appear first. Default: 100. */
  order?: number;
}

/* ── Registry (single source of truth) ─────────────────────────── */

export const ROLE_ACTION_REGISTRY: RoleAction[] = [
  {
    key: "generate",
    label: "Generate Stories",
    icon: "Sparkles",
    href: "/generate?project_id={projectId}",
    roles: ["generate_user_story"],
    order: 10,
  },
  {
    key: "jobs",
    label: "Jobs Dashboard",
    icon: "LayoutDashboard",
    href: "/jobs?project_id={projectId}",
    roles: ["view_user_story"],
    order: 20,
  },
  {
    key: "ingest",
    label: "Ingest Context",
    icon: "Layers",
    href: "/ingest?project_id={projectId}",
    roles: ["context_creation"],
    order: 30,
  },
  {
    key: "code",
    label: "Code Studio",
    icon: "Code2",
    href: "/code-builder",
    roles: ["view_code", "generate_code"],
    order: 40,
  },
  {
    key: "docs",
    label: "Document Builder",
    icon: "BookOpen",
    href: "/document-builder",
    roles: ["view_documents", "generate_hld_documents", "generate_lld_documents", "generate_req_documents", "generate_cust_documents"],
    order: 50,
  },
  {
    key: "modernize",
    label: "Modernization Studio",
    icon: "Layers",
    href: "/legacy-modernization?project_id={projectId}",
    roles: ["generate_code"],
    order: 60,
  },
  {
    key: "edit",
    label: "Edit Settings",
    icon: "Pencil",
    href: "/projects/{projectId}/edit",
    roles: ["edit_project"],
    order: 90,
  },
];

/* ── Helpers ───────────────────────────────────────────────────── */

/**
 * Return the subset of actions the given user is allowed to see.
 *
 * @param userRoles  - role name strings from the JWT `rls` claim
 * @param isAdmin    - true when the user has `role === "admin"`
 * @param projectId  - current project id; inserted into href templates
 */
export function getActionsForUser(
  userRoles: string[],
  isAdmin: boolean,
  projectId: number | string,
): (RoleAction & { resolvedHref: string })[] {
  const roleSet = new Set(userRoles);

  return ROLE_ACTION_REGISTRY
    .filter((a) => isAdmin || a.roles.some((r) => roleSet.has(r)))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    .map((a) => ({
      ...a,
      resolvedHref: a.href.replace(/\{projectId\}/g, String(projectId)),
    }));
}
