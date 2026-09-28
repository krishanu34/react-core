/**
 * daemon-install-state — remembers that the daemon was installed on this
 * machine so the Setup page can offer "Start" instead of re-prompting a
 * download when the daemon is merely stopped.
 *
 * This is a WEB-CLIENT-ONLY heuristic (deliberately not a daemon or backend
 * concept): a browser can't read the disk, so we set the flag the first time
 * a daemon connection succeeds and clear it on one-click Uninstall. It is
 * per-browser-profile — a machine with the daemon installed but never
 * connected from this browser shows the Install panel (harmless: the
 * installer is idempotent), and an out-of-band manual uninstall leaves the
 * flag set (handled by the "Reinstall" link on the Start panel).
 */

const KEY = "devaccel.daemon.installed";

export function markDaemonInstalled(): void {
  try { localStorage.setItem(KEY, "1"); } catch { /* storage unavailable */ }
}

export function clearDaemonInstalled(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

export function wasDaemonInstalled(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
