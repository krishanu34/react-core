# DevAccel Local Daemon

A small helper that runs on the **user's machine** and performs native file I/O on
`127.0.0.1`, so DevAccel clients (browser, CLI, and later IDE) can read & write the
user's local workspace **without HTTPS**. Files never leave the machine — the server
only ever holds metadata + session history.

> **Install & lifecycle documentation** (install location, detection state machine,
> one-click Start/Stop/Update/Uninstall, security model, release runbook):
> see **[LIFECYCLE.md](./LIFECYCLE.md)**.

## Why this exists

"Save to Disk" in the browser used to rely on the File System Access API
(`showDirectoryPicker`), which browsers expose **only in a secure context** (HTTPS or
`localhost`). On a plain-HTTP deployment (e.g. `http://172.191.70.202:3002`) that API is
hidden, so the option disappeared. This daemon replaces that browser API with a native
process the page talks to over loopback — no secure-context requirement.

## Run

```bash
# from the repo (Node 18+; no dependencies):
node daemon/cli.js serve      # start the daemon (binds first free port in 17872–17879)
node daemon/cli.js status     # show discovered daemon info
node daemon/cli.js stop       # stop it
```

The packaged binary supports the same commands plus a one-time install:
```
devaccel install     # ONE-TIME: copy binary + register login auto-start + start in background.
                     # Run this once after downloading; every login after is automatic.
devaccel serve       # just run the daemon (the DEFAULT with no args; used by auto-start & CLI)
devaccel status | stop | uninstall
```

The daemon writes its runtime info to `~/.devaccel/daemon.json` and registered workspace
roots to `~/.devaccel/roots.json`.

## Build a single-file binary (for distribution)

Uses Node's built-in **Single Executable Applications (SEA)** — it packages the
**local** Node binary, so it needs **no network downloads** (works on locked-down
networks, unlike `pkg` which must fetch a base binary from GitHub/nodejs.org).

```bash
cd daemon
npm install          # esbuild + postject (from npm registry, no CDN)
npm run build        # → dist/devaccel-daemon-<os>  (builds for the CURRENT OS)
```

SEA builds for the OS you run it on, so produce each binary on its own OS (or in
per-OS CI):
- Windows → `dist/devaccel-daemon-win.exe`
- macOS   → `dist/devaccel-daemon-macos`
- Linux   → `dist/devaccel-daemon-linux`

> The build prints "signature seems corrupted" — expected (injection invalidates
> the Node binary's signature). **Code-sign** the output (Windows Authenticode /
> macOS notarization) before wide distribution so users don't hit
> SmartScreen/Gatekeeper warnings.

Upload the binaries to Blob under `devaccel-daemon/` (the path the backend's
`/api/daemon/download-url` serves), e.g.:
```bash
az storage blob upload -c dxc-root-v2 -n devaccel-daemon/devaccel-daemon-win.exe \
  -f dist/devaccel-daemon-win.exe --account-name devxcopilotabs --account-key <KEY>
```

## Install (one-time, then auto-start on login)

**Run `devaccel install` once.** This is an explicit one-time step: it copies the binary to a
stable per-user location, registers login auto-start, and starts serving in the background —
no admin/sudo. Every login after that starts the daemon automatically. Running the binary with
**no arguments just serves** (this session only); use `install` to persist it.

On managed/corporate machines, prefer the in-app **Copy install command** (pastes a
download-and-`install` one-liner into a terminal) — double-clicking an unsigned download is
often blocked by SmartScreen/EDR, whereas a terminal launch is not.

The binary installs into **`~/.devaccel`** — the same folder as the daemon's state files
(`daemon.json`, `roots.json`), so uninstall removes a single directory. Pre-0.3.0 installs
(`%LOCALAPPDATA%\DevAccel` on Windows, `~/.local/bin` on unix) are migrated automatically.

| OS | Auto-start mechanism (user-scope) |
|----|-----------------------------------|
| Windows | logon Scheduled Task → `%USERPROFILE%\.devaccel\devaccel.exe` (fallbacks: `HKCU` Run key, hidden Startup-folder VBS) |
| Linux | `systemd --user` service → `~/.devaccel/devaccel` |
| macOS | `launchd` LaunchAgent → `~/.devaccel/devaccel` |

Install also registers the **`devaccel://` URL protocol** (Windows/Linux) so the web app's
"Start daemon" button can launch the installed binary via a native browser prompt — only
`devaccel://start` is honored. A running daemon can also **self-update**: the app POSTs a
download URL to `/daemon/update` (token-gated, https + allowlisted host only) and the daemon
swaps its own binary in place.

Remove auto-start with `devaccel uninstall`.

**Alternative — installer scripts** (`install.ps1` / `install.sh`) do the same thing if you
prefer a script; place the binary next to the script and run it.

In-app, the "Save to Disk isn't available" notice offers a **Download DevAccel daemon** button
(OS-detected, short-lived SAS link) and a **Copy install command** button — the user downloads
the binary and runs `devaccel install` once (or pastes the copied command).

## Supported operating systems
Windows 10/11 (x64), macOS (x64), Linux (x64). Node 18+ if running from source.

## Security

- **Binds `127.0.0.1` only** — never reachable from another machine.
- **CORS + Origin allowlist** — only DevAccel app origins may call it (configure extras via
  `DEVACCEL_ALLOWED_ORIGINS`, comma-separated). A random website cannot reach the daemon.
- **Token pairing** — an allowlisted origin calls `POST /pair` to get a token; every
  `/fs/*` request must present it (`Authorization: Bearer <token>`).
- **Session-bound pairing** — when `DEVACCEL_REQUIRE_AUTH` is on (default), a browser must
  send its DevAccel session token + a `verifyUrl` at `/pair`; the daemon confirms the login
  by calling the app back (introspection) before issuing a token. An SSRF guard requires the
  `verifyUrl` to share the pairing origin. CLI callers (no `Origin`) are trusted locally.
- **Path sandbox** — all I/O confined to a registered workspace root; `..`/absolute
  escapes are rejected.

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | none | Discovery: `{ ok, name, version }` |
| POST | `/pair` | origin | Returns `{ token }` for an allowlisted origin |
| POST | `/fs/open` | token | Register a root by absolute path → `{ rootId, root }` |
| GET | `/fs/scan?rootId=` | token | List the tree (`{ nodes }`) |
| GET | `/fs/read?rootId=&path=` | token | Read a file as UTF-8 text (`{ content }`) |
| GET | `/fs/read-bytes?rootId=&path=[&maxBytes=]` | token | Read RAW bytes → `{ base64, size }`. 413 when over `maxBytes` (default 25 MB) |
| PUT | `/fs/write` | token | `{ rootId, path, content }` — UTF-8 text |
| PUT | `/fs/write-bytes` | token | `{ rootId, path, base64 }` → `{ ok, size }` — raw bytes |
| POST | `/fs/create` | token | `{ rootId, path, type }` |
| DELETE | `/fs/entry` | token | `{ rootId, path }` |
| POST | `/fs/rename` | token | `{ rootId, oldPath, newPath }` |
| POST | `/fs/pick-folder` | token | Opens the native OS folder dialog → `{ path }` \| `{ canceled }` \| `{ error }` |

The `-bytes` variants exist because the text ones go through UTF-8, which
silently destroys any non-text format — a `.docx` or `.pdf` round-tripped
through `/fs/read` is replacement characters that no parser can recover. They
are what lets the browser parse a document in the user's repo (`read_file` on
a `.docx`) and save an attachment to disk unmodified, without the file ever
being uploaded. Base64 is the only way to carry bytes over this JSON transport;
it costs 4/3 of the file size on the wire, which is why `maxBytes` is enforced
before the read rather than after.

### Env vars
- `DEVACCEL_PORT` — force a specific port (default: first free in `17872–17879`).
- `DEVACCEL_ALLOWED_ORIGINS` — extra allowed origins (comma-separated).
- `DEVACCEL_REQUIRE_AUTH` — `false` to disable session-introspection at `/pair` (default on).

## Troubleshooting
- **Notice still shows after starting the daemon:** refresh the page; confirm the page origin
  is allowlisted; check `curl http://127.0.0.1:17872/health`.
- **`/pair` returns 401:** your DevAccel session is invalid/expired — log in again; or the
  backend `/api/daemon/verify` is unreachable.
- **`/pair` returns 400 `bad_verify_url`:** the app origin isn't the one hosting the verify
  endpoint (SSRF guard). **403 `forbidden_origin`:** add the origin to `DEVACCEL_ALLOWED_ORIGINS`.
- **Port in use:** another daemon is running (`node daemon/cli.js status`/`stop`) or set `DEVACCEL_PORT`.

## Client integration

The browser side lives in [`ui/src/lib/fileAccess/`](../ui/src/lib/fileAccess): `agentClient`
(discovery + pairing) and `AgentFileAccess` (implements the shared `FileAccess` interface,
alongside `FsApiFileAccess`). The IDE resolves the right transport per workspace via
`getWorkspaceFileAccess`, with an availability ladder: **daemon → File System Access API →
actionable notice**.
