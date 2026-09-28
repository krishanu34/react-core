# Deploying "Save to Disk over HTTP" (Local Daemon) to the VM

Step-by-step guide to ship the local-daemon feature to the DevAccel VM
(`http://172.191.70.202:3002`).

---

## 0. Concept — what runs where

The daemon runs on **each end user's machine**, NOT on the VM. The VM only hosts
the app (UI + backend) and serves the daemon binary for download.

```
VM (172.191.70.202)                         Each user's machine
┌───────────────────────────┐               ┌──────────────────────────────┐
│ UI (Next.js, :3002)        │◄──HTTP────────│ Browser                       │
│ devsphere_ai backend(:8003)│               │   ↓ talks to 127.0.0.1        │
│   /api/daemon/verify       │◄──verify──────│ devaccel daemon (binary)      │
│   /api/daemon/download-url │               │   → writes to the LOCAL disk  │
└───────────────────────────┘               └──────────────────────────────┘
        Azure Blob: daemon installer binaries
```

Deploy checklist: **(A)** build binaries → **(B)** upload to Blob → **(C)** deploy
UI + backend on the VM → **(D)** verify → **(E)** users install the daemon.

---

## Prerequisites

- SSH access to the VM; the repo checked out there (same path used by `startup.sh`).
- On the VM: Node 18+, PM2 (already used by `startup.sh`).
- Azure access to Storage account `devxcopilotabs`, container `dxc-root-v2`
  (`az` CLI logged in, or the account key from `.env`).
- A machine per target OS to build that OS's binary (or CI). Windows binary can be
  built on any Windows box; macOS/Linux on those OSes.

---

## A. Build the daemon binaries

Uses Node's built-in **Single Executable Applications (SEA)** — no network
downloads (works on locked-down networks). Run on each OS you want to support.

```bash
cd daemon
npm install            # esbuild + postject (npm registry only, no CDN)
npm run build          # → dist/devaccel-daemon-<os>  (for the CURRENT OS)
```

Outputs (per OS run):
- Windows → `dist/devaccel-daemon-win.exe`
- macOS   → `dist/devaccel-daemon-macos`
- Linux   → `dist/devaccel-daemon-linux`

> A "signature seems corrupted" warning is expected. Before wide distribution,
> **code-sign** the binaries (Windows Authenticode / macOS notarization) so users
> don't get SmartScreen/Gatekeeper warnings on first run.

> **Building while the daemon is running:** `npm run build` works even if a daemon
> is currently running from `dist/` — Windows can't overwrite a running `.exe`, so
> the build renames the old one aside (`devaccel-daemon-win.exe.old-<ts>`, cleaned
> up on the next build) and writes a fresh binary. **Restart the daemon afterward**
> to pick up the changes.

Smoke-test a binary:
```bash
./dist/devaccel-daemon-win.exe serve      # prints "listening on http://127.0.0.1:17872"
curl http://127.0.0.1:17872/health        # {"ok":true,...}  (from a second terminal)
```

### Rebuild → restart loop (during development)
```bash
cd daemon
npm run build                              # rebuild (safe even if a daemon is running)
# stop the old daemon, then start the new build:
./dist/devaccel-daemon-win.exe stop        # or: taskkill //F //IM devaccel-daemon-win.exe   (Windows)
./dist/devaccel-daemon-win.exe serve
```

---

## B. Upload binaries to Blob

The backend serves them from container `dxc-root-v2` under the `devaccel-daemon/`
prefix. Blob names MUST match exactly:

| Platform | Blob name |
|---|---|
| win | `devaccel-daemon/devaccel-daemon-win.exe` |
| mac | `devaccel-daemon/devaccel-daemon-macos` |
| linux | `devaccel-daemon/devaccel-daemon-linux` |

**Primary — publish script** (uploads via the app's own Blob helper, same pattern
the rest of the app uses; reads `BLOB_STORAGE_*` from `.env`):
```bash
python daemon/scripts/publish.py            # uploads whatever is in daemon/dist/
python daemon/scripts/publish.py --build    # run `npm run build` (current OS) first, then upload
```
It uploads each built binary to the exact blob name the backend serves
(`common_utils/daemon_assets.py` is the shared source of truth), skips OSes not
built on this machine, and prints the resulting blob URLs. Run it on each OS (or
in CI) to publish all three.

**Fallback — Azure CLI** (equivalent, if you prefer):
```bash
az storage blob upload \
  --account-name devxcopilotabs -c dxc-root-v2 \
  -n devaccel-daemon/devaccel-daemon-win.exe \
  -f dist/devaccel-daemon-win.exe \
  --account-key "<BLOB_STORAGE_ACCOUNT_KEY from .env>" --overwrite
```
Repeat for `-macos` / `-linux`, or upload via the Azure Portal into a
`devaccel-daemon/` folder.

> The prefix is configurable via the `DAEMON_BLOB_PREFIX` env var (default
> `devaccel-daemon`) — it's read by both the publish script and the download
> endpoint through `common_utils/daemon_assets.py`, so they never drift.

---

## C. Deploy the app changes on the VM

SSH to the VM, pull the branch, then rebuild the UI and restart the backend.

```bash
cd /path/to/DevAccelv2
git pull                      # get the daemon feature branch

# 1) Rebuild the Next.js UI (standalone build is precompiled → must rebuild)
cd ui
npm ci
npm run build
# copy static assets into standalone (matches startup.sh behaviour)
cp -r public .next/standalone/ 2>/dev/null || true
cp -r .next/static .next/standalone/.next/ 2>/dev/null || true
cd ..

# 2) Restart the two affected PM2 services
pm2 restart devaccel-ui                 # serves the new fileAccess + download UI
pm2 restart devaccel-devsphere-ai       # loads the new /api/daemon/* router
pm2 save
```

> Alternatively, a full redeploy via `./startup.sh` rebuilds and restarts
> everything. The other backends (`devaccel-api`, `-code-builder`,
> `-legacy-modernization`) are unaffected and don't need restarting.

Nothing else changed server-side: no DB migration, no new file storage.

---

## D. Configuration

### Daemon origin allowlist (client side)
The daemon only accepts calls from allowlisted origins. The VM origin
`http://172.191.70.202:3002` is already a built-in default. If you deploy under a
new IP/domain, either rebuild the daemon with the new default in
`daemon/config.js`, or have users start it with:
```bash
DEVACCEL_ALLOWED_ORIGINS="https://newhost.example.com" devaccel serve
```

### Backend env (VM)
Already present in `.env` — no new required vars:
- `BLOB_STORAGE_ACCOUNT_NAME`, `BLOB_STORAGE_ACCOUNT_KEY`, `BLOB_STORAGE_CONTAINER_NAME` (for the download link).
- `SECRET_KEY` + JWT settings (for `/api/daemon/verify`).
- Optional: `DAEMON_BLOB_PREFIX` (default `devaccel-daemon`).

### Session auth
On by default (`DEVACCEL_REQUIRE_AUTH=true` on the daemon). Users must be logged
in to pair; the daemon verifies the session against the VM before issuing a token.

---

## E. End-user daemon install (on their own machine)

1. In the app, when local save is unavailable, click **Download DevAccel daemon**
   (OS auto-detected) → downloads the binary. (Or click **Copy install command** to
   copy a download-and-install one-liner — best on managed machines.)
2. **Install it once (explicit):** run `devaccel install` — e.g. in a terminal:
   `devaccel-daemon-win.exe install`. This copies the binary to a stable per-user
   location, **registers login auto-start** (Startup-folder launcher on Windows,
   `systemd --user` on Linux, `launchd` on macOS), and starts it in the background —
   **no admin.** (Running the binary with no arguments just serves for this session
   without persisting; use `install` to make it permanent.)
   - On managed/corporate machines, double-clicking an unsigned download is often
     blocked by SmartScreen/EDR — use the **Copy install command** (terminal) path,
     or right-click the file → Properties → **Unblock** first.
3. Back in the browser, refresh (or return to the tab) → **"Local daemon connected"**
   → Save to Disk works.

From then on the daemon auto-starts at every login — the user never repeats this.
Remove it any time with `devaccel uninstall`. (`install.ps1` / `install.sh` do the
same as `install` if you prefer a script.)

---

## F. Verify the deployment

From the VM (or any machine that can reach it), with a valid login token
(`localStorage.getItem('auth_token')` in the browser console):

```bash
# 1) Backend router is live + session verify works
curl -s http://127.0.0.1:8003/api/daemon/verify -H "Authorization: Bearer <TOKEN>"   # {"ok":true,...}
curl -s http://127.0.0.1:8003/api/daemon/verify -H "Authorization: Bearer bad"        # 401

# 2) Download link is issued (SAS URL)
curl -s "http://127.0.0.1:8003/api/daemon/download-url?platform=win" -H "Authorization: Bearer <TOKEN>"
#   → {"url":"https://devxcopilotabs.blob.core.windows.net/.../devaccel-daemon-win.exe?<SAS>", ...}
#   Opening that URL should download the binary (not BlobNotFound).
```

In the browser (logged in, on the VM over HTTP), with the daemon installed:
- New Workspace shows **"Local daemon connected"**.
- Upload files → **Save to disk via daemon** → files appear in the chosen local
  folder and in the explorer.
- Network tab: file bytes go to `127.0.0.1`; only metadata/session calls hit the VM.

---

## G. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Download button → `BlobNotFound` | Binary not uploaded — do Part B (exact blob path). |
| `/api/daemon/verify` 404 | Backend not restarted — `pm2 restart devaccel-devsphere-ai`. |
| Download button not shown | UI not rebuilt (`npm run build` + `pm2 restart devaccel-ui`); or daemon already running; or on localhost/HTTPS (uses browser API). |
| "Local daemon connected" but you stopped it | An orphaned daemon still listens — `curl 127.0.0.1:17872/health`, then `devaccel stop` / `taskkill`. Refresh the page (badge is cached per page load). |
| Pair → 401 "session verification failed" | Not logged in / token expired, or the daemon can't reach the VM's `/workspace-api/daemon/verify`. |
| Pair → 403 forbidden_origin | Page origin not allowlisted — set `DEVACCEL_ALLOWED_ORIGINS`. |
| Pair → 400 bad_verify_url | verifyUrl origin ≠ app origin (SSRF guard) — expected only if misconfigured. |
| First-run OS warning | Binary unsigned — code-sign it (Windows Authenticode / macOS notarization). |

---

## H. Rollback

The feature is additive — to roll back:
- `git checkout <previous-commit>` for `ui/` and `devsphere_ai/`, rebuild UI,
  `pm2 restart devaccel-ui devaccel-devsphere-ai`.
- No DB or file-storage changes to undo. Blob binaries can be left in place.

---

## Daemon commands (quick reference)

Run against the packaged binary (`dist/devaccel-daemon-win.exe`) or the installed
copy (`%USERPROFILE%\.devaccel\devaccel.exe`). From source, use `node cli.js <cmd>`.

| Command | What it does |
|---|---|
| `devaccel serve` | Run the daemon in the foreground on `127.0.0.1` (also the default with no args). |
| `devaccel install` | **One-time**: copy the binary to `%USERPROFILE%\.devaccel`, register login auto-start + the `devaccel://` protocol, start it. Migrates pre-0.3.0 installs from `%LOCALAPPDATA%\DevAccel` / `~/.local/bin`. |
| `devaccel protocol <url>` | OS-invoked handler for `devaccel://` links; only `devaccel://start` is honored (starts the installed daemon). |
| `devaccel status` | Print the running daemon's info (`~/.devaccel/daemon.json`). |
| `devaccel stop` | Stop the running daemon (by pid). |
| `devaccel uninstall` | Remove the login auto-start (leaves the binary + files). |

### Build / publish
```bash
cd daemon
npm install                               # first time only (esbuild + postject)
npm run build                             # → dist/devaccel-daemon-<os>  (safe while a daemon runs)
python scripts/publish.py                 # upload dist/ binaries to Blob (add --dry-run to preview)
python scripts/publish.py --build         # build (current OS) then upload
```

### Start / stop / status (Windows)
```powershell
.\dist\devaccel-daemon-win.exe serve                     # start (foreground)
Start-Process .\dist\devaccel-daemon-win.exe -Args serve # start (background)
.\dist\devaccel-daemon-win.exe status
.\dist\devaccel-daemon-win.exe stop
# force-stop / free a locked exe:
taskkill /F /IM devaccel-daemon-win.exe
```

### Install (persistent, auto-start) / update / uninstall
```powershell
.\dist\devaccel-daemon-win.exe install     # install + auto-start (one time)
.\dist\devaccel-daemon-win.exe install     # run again to UPDATE the installed copy to a new build
.\dist\devaccel-daemon-win.exe uninstall   # remove auto-start
# full manual cleanup:
rmdir /s /q "%USERPROFILE%\.devaccel"
rmdir /s /q "%LOCALAPPDATA%\DevAccel"
powershell -Command "Unregister-ScheduledTask -TaskName DevAccelDaemon -Confirm:$false -ErrorAction SilentlyContinue"
powershell -Command "Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name DevAccelDaemon -ErrorAction SilentlyContinue"
powershell -Command "Remove-Item -Path 'HKCU:\Software\Classes\devaccel' -Recurse -Force -ErrorAction SilentlyContinue"
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DevAccelDaemon.vbs"
```

### Health / discovery
```bash
curl http://127.0.0.1:17872/health          # daemon reports {"ok":true, version}
netstat -ano | grep 1787                     # which port a daemon is listening on (17872–17879)
```

### End-user first-time install (managed/corporate machines)
Double-clicking an unsigned download is often blocked (SmartScreen/EDR). Use the in-app
**Copy install command** (downloads + `install` in one terminal paste), or:
```powershell
# right-click the downloaded file → Properties → Unblock → OK, then:
.\devaccel-daemon-win.exe install
```

---

## Automated tests (run any time)

```bash
cd daemon && npm test                                   # daemon: fs + API + security + auth
cd ../ui && npx vitest run src/__tests__/fileAccess.test.ts   # client adapters
```

---

## Appendix — Reference tables

Consolidated copy of the key tables for quick lookup.

### Table 1 — Blob-name mapping (upload targets)

The backend serves each OS binary from container `dxc-root-v2` at these exact
blob names. Upload the built binary to the matching path or Download returns
`BlobNotFound`.

| Platform | Blob name |
|---|---|
| win | `devaccel-daemon/devaccel-daemon-win.exe` |
| mac | `devaccel-daemon/devaccel-daemon-macos` |
| linux | `devaccel-daemon/devaccel-daemon-linux` |

### Table 2 — Troubleshooting matrix

| Symptom | Cause / fix |
|---|---|
| Download button → BlobNotFound | Binary not uploaded — do Part B (exact blob path). |
| `/api/daemon/verify` 404 | Backend not restarted — `pm2 restart devaccel-devsphere-ai`. |
| Download button not shown | UI not rebuilt (`npm run build` + `pm2 restart devaccel-ui`); or daemon already running; or on localhost/HTTPS (uses browser API). |
| "Local daemon connected" but you stopped it | An orphaned daemon still listens — `curl 127.0.0.1:17872/health`, then `devaccel stop` / `taskkill`. Refresh the page (badge is cached per page load). |
| Pair → 401 "session verification failed" | Not logged in / token expired, or the daemon can't reach the VM's `/workspace-api/daemon/verify`. |
| Pair → 403 forbidden_origin | Page origin not allowlisted — set `DEVACCEL_ALLOWED_ORIGINS`. |
| Pair → 400 bad_verify_url | verifyUrl origin ≠ app origin (SSRF guard) — expected only if misconfigured. |
| First-run OS warning | Binary unsigned — code-sign it (Windows Authenticode / macOS notarization). |
