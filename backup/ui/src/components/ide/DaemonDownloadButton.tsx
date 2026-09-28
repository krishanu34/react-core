"use client";

import React, { useEffect, useState } from "react";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { detectOS, getDaemonDownloadUrl, OS_LABEL, type DaemonOS } from "@/lib/daemon-download";

/**
 * Build a paste-into-terminal install command for the given OS + SAS URL.
 * Terminal launches bypass the SmartScreen/EDR gate that silently blocks
 * double-clicking unsigned downloads on locked-down corporate machines.
 */
function installCommand(os: DaemonOS, url: string): string {
  if (os === "win") {
    // PowerShell: download straight into ~/.devaccel under a SETUP name (never
    // the live binary name, so a running daemon can't lock the target), strip
    // Mark-of-the-Web, run the installer. Start-Process -Wait is required: the
    // exe is GUI-subsystem (build-sea.mjs), so `& $f install` would return
    // immediately. The installer deletes the setup file itself when done.
    return (
      `$d = Join-Path $env:USERPROFILE '.devaccel'; ` +
      `New-Item -ItemType Directory -Force -Path $d | Out-Null; ` +
      `$f = Join-Path $d 'devaccel-setup.exe'; ` +
      `iwr "${url}" -OutFile $f; Unblock-File $f; ` +
      `Start-Process -FilePath $f -ArgumentList 'install' -Wait`
    );
  }
  return (
    `mkdir -p ~/.devaccel && curl -fsSL "${url}" -o ~/.devaccel/devaccel-setup && ` +
    `chmod +x ~/.devaccel/devaccel-setup && ~/.devaccel/devaccel-setup install`
  );
}

/**
 * Download-the-daemon control shown when local file access is unavailable.
 * OS is auto-detected but selectable; clicking fetches a short-lived SAS link
 * from the backend and starts the browser download of the installer binary.
 */
export function DaemonDownloadButton() {
  // Start with a stable default so server and client render identically (no
  // `navigator` on the server); detect the real OS after mount. Prevents a
  // hydration mismatch.
  const [os, setOs] = useState<DaemonOS>("win");
  useEffect(() => { setOs(detectOS()); }, []);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  const download = async () => {
    setBusy(true);
    setErr("");
    try {
      const { url } = await getDaemonDownloadUrl(os);
      // Navigating to the SAS URL triggers the browser's file download.
      window.location.href = url;
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /* Corporate machines often block double-clicking unsigned downloads outright;
     a pasted terminal command is the reliable install path there. */
  const copyCommand = async () => {
    setBusy(true);
    setErr("");
    try {
      const { url } = await getDaemonDownloadUrl(os);
      await navigator.clipboard.writeText(installCommand(os, url));
      setCopied(true);
      setTimeout(() => setCopied(false), 4000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <select
          value={os}
          onChange={(e) => setOs(e.target.value as DaemonOS)}
          className="h-7 rounded-md border border-slate-600 bg-slate-900 px-2 text-[11px] text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
        >
          {(Object.keys(OS_LABEL) as DaemonOS[]).map((k) => (
            <option key={k} value={k}>{OS_LABEL[k]}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={download}
          disabled={busy}
          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-[11px] font-medium text-white transition-colors"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          {busy ? "Preparing…" : "Download DevAccel daemon"}
        </button>
        <button
          type="button"
          onClick={copyCommand}
          disabled={busy}
          title="For locked-down machines: paste this into a terminal to download & install"
          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-slate-600 hover:border-violet-500 disabled:opacity-50 text-[11px] font-medium text-slate-300 hover:text-violet-300 transition-colors"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied — paste in a terminal" : "Copy install command"}
        </button>
      </div>
      <p className="mt-1 text-[10px] text-slate-500 leading-relaxed">
        Run it once — it installs itself into{" "}
        <span className="text-slate-400">{os === "win" ? "%USERPROFILE%\\.devaccel" : "~/.devaccel"}</span>,
        starts in the background (no console window) and launches automatically on every future login.
        After that, Start / Stop / Update / Uninstall are all one-click from this page. On managed machines,
        double-click is often blocked, so use <span className="text-slate-400">Copy install command</span>{" "}
        and paste it into {os === "win" ? "PowerShell" : "a terminal"} — it downloads straight into{" "}
        <span className="text-slate-400">.devaccel</span> and installs in one step.
      </p>
      {err && <p className="mt-1 text-[10px] text-red-400">{err}</p>}
    </div>
  );
}

export default DaemonDownloadButton;
