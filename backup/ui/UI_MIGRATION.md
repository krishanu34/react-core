# UI standalone migration — remaining steps

The full DevAccel UI was lifted here as a **working baseline** so no workspace
functionality is lost. Auth, branding, and API base URLs are already repointed at
the standalone DevSphere backend (`:8003`). What remains is trimming the non-workspace
modules and replacing the multi-module shell with a workspace-centric one. Do these
with `npm run dev` running so each change is verified against a live compile.

## 1. Repoint / verify (done)
- `src/lib/auth.ts` → `NEXT_PUBLIC_DEVSPHERE_API_URL` + `/auth/login`, `/auth/logout`.
- `src/app/layout.tsx` metadata + `src/app/login/page.tsx` branding → DevSphere AI.
- `.env.local.example` → backend at `:8003`.
- Proxies `src/app/devsphere-api/*` and `src/app/workspace-api/*` already env-driven.

## 2. Delete non-workspace routes (`src/app/`)  ✅ DONE
Removed: `admin/`, `code-builder/`, `db-monitor/`, `document-builder/`, `generate/`,
`health/`, `ingest/`, `jobs/`, `legacy-modernization/`, `lm-api/`, `projects/`,
`standards/`. Kept: `workspaces/`, `login/`, `profile/`, `devsphere-api/`,
`workspace-api/`, `layout.tsx`, `globals.css`, `page.tsx`.

## 3. Delete non-workspace components (`src/components/`)  — OPTIONAL cleanup
`code-builder/`, `code-builder-v2/`, `legacy-modernization/` are now orphaned (their
routes are gone) but still compile; delete them only after confirming (with the dev
server) nothing shared imports them.
⚠ **Keep `story-builder/`** — it is still referenced by:
- `src/app/profile/page.tsx` → `story-builder/page-header` (`PageHeader`).
- `src/app/workspaces/[id]/ide/page.tsx` → `story-builder/sidebar` (`Sidebar`) for the
  IDE ActivityBar **`appnav`** view.
To fully drop it, first remove the `appnav` view from `src/components/ide/ActivityBar.tsx`
+ the `Sidebar` usage in the IDE page, and swap `PageHeader` for a small local header.
`ProjectProvider` is intentionally **kept** (≈20 workspace/IDE files consume
`useGlobalProject`); the projects *DB* coupling is already removed.

## 4. New workspace-centric shell  ✅ DONE
`src/components/shell/DevSphereShell.tsx` — slim top bar (DevSphere brand → `/workspaces`,
account menu), no multi-module sidebar, keeps `ProjectProvider`. Wired into `layout.tsx`
(replaces `AppShell`; the old `app-shell.tsx` is now unused). Home `page.tsx` redirects
to `/workspaces`.

## 5. New home = Workspaces dashboard
Rewrite `src/app/page.tsx` to redirect to `/workspaces`, and redesign
`src/app/workspaces/page.tsx` as a card/grid launcher:
- one card per workspace: name, last-accessed, daemon/connector status dot,
  primary "Open IDE" action, overflow (rename/archive/delete),
- prominent "New workspace" CTA (reuse `components/ide/NewWorkspaceModal.tsx`),
- empty state that links to Daemon Setup (`/workspaces/setup`).
Remove `GlobalProjectDropdown` and any project filter from the list query
(`src/lib/workspace-api.ts` — drop the `project_id` filter; list by owner).

## 6. Wire the agent thread id to the workspace tracking id (unified model)
The backend now returns `tracking_id` on every `WorkspaceResponse` (done). The chosen
data model is **workspace owns the tracking id (1:1)** — one workspace, one stable
`tracking_id` that the agent uses as its thread handle.

Today the UI instead derives the agent thread id **per chat session**
(`activeSession.threadId` in `components/ide/ChatDock.tsx`, generated client-side by
`hooks/useSessions.ts`). Reconcile it to the unified model:
- Expose `trackingId` from `providers/WorkspaceProvider.tsx` (read `tracking_id` off the
  `getWorkspace()` response in `src/lib/workspace-api.ts`).
- In `ChatDock.tsx`, use `workspace.trackingId` as the agent `thread_id` for the primary
  conversation. Keep multiple UI "sessions" only as saved views/snapshots of that one
  thread (they already persist via `chat_messages`), OR drop multi-session down to one
  active session per workspace — do NOT let each session mint a new `tracking_id`, or you
  recreate the two-id split this migration removed.
- Confirm `src/lib/devsphere-agent-api.ts` sends `Authorization: Bearer <jwt>` (the agent
  stream is now JWT-authed).

## 7. Verify
`npm run build` clean, `npm run test` (vitest) for `components/ide/*`, then the
end-to-end flow: login → dashboard → new workspace → daemon → IDE → agent run.
