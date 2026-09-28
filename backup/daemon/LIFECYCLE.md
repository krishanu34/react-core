# DevAccel Daemon — Install & Lifecycle Management

**Daemon version:** 0.3.1 · **Audience:** developers & operators of DevAccel

This document describes how the DevAccel local daemon is installed, detected,
started, stopped, updated and uninstalled — and *why* it works the way it does.

---

## 1. The problem and the constraint

The DevAccel web app needs a native helper (the daemon) on the user's machine
for local file access. A **browser page cannot**:

- write a file to a path of its choosing (downloads always go to the browser's
  download directory),
- read the disk (so it can't check whether the daemon is downloaded/installed),
- launch or kill a process silently.

These are hard browser-security guarantees, not missing features. The design
therefore uses **one unavoidable browser-mediated install**, after which the
installed daemon (native code) does everything else — so the Downloads folder
and the terminal are never needed again.

---

## 2. Install location

Everything lives in **one folder**: `~/.devaccel`
(`C:\Users\<user>\.devaccel` on Windows).

| File | Purpose |
|---|---|
| `devaccel.exe` / `devaccel` | the installed daemon binary |
| `daemon.json` | runtime info (port, pid) written on start |
| `roots.json` | registered workspace roots |
| `devaccel-setup(.exe)` | transient installer download — auto-deleted after install |

- Installs are **user-scope only — no admin/sudo ever required**.
- Pre-0.3.0 installs (`%LOCALAPPDATA%\DevAccel` on Windows, `~/.local/bin` on
  mac/Linux) are **migrated automatically**: the old process is stopped and the
  old binary removed the first time the 0.3.0 installer runs.
- Uninstall deletes this single folder plus all registrations.

### What `devaccel install` registers (per OS)

| OS | Auto-start | `devaccel://` protocol |
|---|---|---|
| Windows | logon Scheduled Task `DevAccelDaemon` (PowerShell API — works where `schtasks.exe`/`reg.exe` are policy-blocked); fallbacks: HKCU Run key → Startup-folder VBS | `HKCU:\Software\Classes\devaccel` |
| Linux | `systemd --user` service | `~/.local/share/applications/devaccel-daemon.desktop` + `xdg-mime` |
| macOS | launchd LaunchAgent (RunAtLoad + KeepAlive) | not possible for a bare binary (needs an app bundle) — copy-paste start command is used instead |

---

## 3. First-time install (the only browser-limited step)

Two paths on the Setup page (`ui/src/app/workspaces/setup/page.tsx`):

1. **Download button** — browser downloads the exe (Downloads folder,
   unavoidable), user runs it once; it self-installs into `~/.devaccel`.
2. **Copy install command** — a PowerShell/bash one-liner that downloads the
   binary **directly into `~/.devaccel`** as `devaccel-setup(.exe)` and runs
   `install`. Skips the Downloads folder entirely; also the reliable path on
   managed machines where double-clicking unsigned downloads is blocked by
   SmartScreen/EDR. The installer deletes the setup file when done.

Binaries are served via short-lived Azure Blob SAS links from
`GET /api/daemon/download-url` (backend:
`devsphere_ai/workspace_studio/controllers/daemon.py`).

---

## 4. Detection — the Setup page state machine

The browser can't see the disk, so detection is a combination of a **live
probe** and **remembered state**:

| State | Signal | UI shown |
|---|---|---|
| **Running** | `GET /health` answers on a port in 17872–17879 (polled every 4 s, `ui/src/lib/hooks/useDaemonStatus.ts`) | Manage panel — Stop / Update / Uninstall. No download offered. |
| **Installed, stopped** | localStorage flag `devaccel.daemon.installed` (`ui/src/lib/daemon-install-state.ts`) — set on the first successful *disconnected → connected* transition, cleared by Uninstall | Start panel. No download offered. |
| **Never installed** | neither | Install panel (Download / Copy command) |

Known limits of the flag (documented trade-offs of a browser client):

- Per-browser-profile: another browser on the same machine shows the Install
  panel until it connects once (harmless — the installer is idempotent).
- Removed out-of-band (folder deleted manually): the flag stays set; the Start
  panel's **"Not installed anymore? Reinstall"** link is the escape hatch.
- The flag is set only on a genuine disconnected→connected **transition** — not
  on every probe — so the brief window where the daemon is still alive right
  after Uninstall cannot re-set it (this was a real race, fixed in 0.3.0).

---

## 5. Lifecycle operations

### Start (one click)
The Start button navigates to **`devaccel://start`**. The browser shows a
native "Open DevAccel?" prompt (checkbox to always allow), then the OS runs
`devaccel.exe protocol "devaccel://start"`, which starts the daemon detached.
- **Security:** any website can fire `devaccel://` URLs, so `cli.js` honors
  **only** `devaccel://start` and ignores everything else; nothing from the URL
  is shell-interpolated. Starting the daemon is the sole possible effect —
  file access still requires origin-allowlist + token pairing.
- Fallback (shown after ~10 s without a connection, and always on macOS):
  copy-paste `& "$env:USERPROFILE\.devaccel\devaccel.exe" install`
  (idempotent — starts the daemon and repairs auto-start).

### Stop / Uninstall (one click)
Token-gated HTTP to the running daemon (`POST /daemon/stop`,
`POST /daemon/uninstall` in `daemon/server.js`). The daemon replies 200
**first**, then does all teardown in the background and exits — the auto-start
removal shells out to PowerShell, which can take seconds on managed/EDR
machines, so it must never run before the response (the client would time out
while the daemon still looked connected). Both endpoints also kill any **stray
second instance** of the installed binary; a survivor would be rediscovered
seconds later (Stop "does nothing") and would hold the exe locked so the
uninstall folder deletion silently failed.

Client side (`ui/src/lib/fileAccess/agentClient.ts`): a dropped connection or
timeout is the only alternate success signal — HTTP errors **surface as real
failures** (a stale pairing token after a daemon restart used to 401, which was
swallowed and shown as "stopped/uninstalled" while the daemon kept running; the
client now re-pairs automatically on 401). After the request, the client polls
until **no daemon answers on any port** before reporting success, so the UI can
never show a green "connected" card next to an uninstall notice.

Uninstall removes the Scheduled Task / service, the `devaccel://` registration,
schedules deletion of `~/.devaccel` (including pre-0.3.0 leftovers), and the
web app clears the installed flag so the Install panel returns.

### Update (one click, no browser download)
- `daemon/scripts/publish.py` uploads a `manifest.json` (`{"version": "x.y.z"}`)
  next to the binaries in Blob storage.
- Backend `GET /api/daemon/latest-version` reads it (5-min in-process cache).
- The Setup page compares it to the running daemon's `/health` version and
  shows **"Update to vX.Y.Z"** when newer.
- Clicking it: the app fetches a fresh SAS URL and calls
  `POST /daemon/update {url}`. **The daemon downloads the new binary itself**
  into `~/.devaccel/devaccel-setup(.exe)`, launches it with `install`
  (which stops the old process, swaps the binary with retry, restarts, and
  deletes the setup file).
- **SSRF guard:** the daemon only accepts `https://` URLs on hosts ending in
  `.blob.core.windows.net` (extend via `DEVACCEL_UPDATE_HOSTS`), and rejects
  downloads smaller than 10 MB (error pages aren't binaries).

---

## 6. Security model (unchanged invariants)

- Daemon binds **127.0.0.1 only**; never reachable from another machine.
- CORS + Origin allowlist (`daemon/config.js`) — only DevAccel app origins.
- Token pairing bound to a live DevAccel session (daemon introspects the
  session token via `GET /api/daemon/verify` before issuing its token).
- All file I/O sandboxed to explicitly registered workspace roots.
- Everything user-scope; **no Administrator/root rights anywhere**.
- The only user-visible prompt in the whole lifecycle is the browser's
  one-time "Open DevAccel?" dialog on Start.

---

## 7. Ports & sync constraints (do not drift)

| Value | Defined in | Mirrored in |
|---|---|---|
| Port range 17872–17879 | `daemon/config.js` | `ui/src/lib/fileAccess/agentClient.ts` (`AGENT_PORTS`) |
| Blob asset names + prefix | `common_utils/daemon_assets.py` | used by both the download endpoint and `publish.py` |
| Allowed origins | `daemon/config.js` (`DEVACCEL_ALLOWED_ORIGINS` env to extend) | — |
| Update host allowlist | `daemon/config.js` (`DEVACCEL_UPDATE_HOSTS` env to extend) | — |

---

## 8. Testing & release runbook

### Local test
```powershell
# install / upgrade from a local build
cd daemon && npm run build
Start-Process .\dist\devaccel-daemon-win.exe -ArgumentList 'install' -Wait

# verify
iwr http://127.0.0.1:17872/health                      # version
Test-Path "$env:USERPROFILE\.devaccel\devaccel.exe"    # installed
(Get-ScheduledTask DevAccelDaemon).Actions.Execute     # auto-start path
Get-Item 'HKCU:\Software\Classes\devaccel\shell\open\command'  # protocol
```
Then in the app: Stop → Start panel → **Start daemon** → reconnects;
**Uninstall** → Install panel returns and `~/.devaccel` is gone.

### Unit tests
```bash
cd daemon && npm test    # includes install-path + /daemon/update security tests
cd ui && npm run lint && npm run build
```

### Publish (only after local testing passes)
```bash
PYTHONIOENCODING=utf-8 python daemon/scripts/publish.py          # uploads binaries + manifest.json
```
Bump `daemon/package.json` version first — the Update button appears for users
only when the published manifest version exceeds their running version.

---

## 9. Known limitations & future direction

- "Downloaded but never run" cannot be detected by a web page (no site can see
  the Downloads folder). Optional mitigation: remember the Download click in
  localStorage and change the button copy.
- Full, prompt-free, real-disk detection and silent start require a native
  client surface: either a **browser extension + native-messaging host** or the
  planned **VS Code extension / CLI client** — the backend and daemon APIs are
  already client-agnostic for that (see `.claude/CLAUDE.md` architecture
  rules), so no server changes will be needed.
- The binary is unsigned; SmartScreen/EDR friction on first install is worked
  around (terminal one-liner, MOTW strip, GUI-subsystem exe), but a code-signing
  certificate is the proper long-term fix.
