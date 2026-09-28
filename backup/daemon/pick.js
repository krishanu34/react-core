"use strict";

/**
 * pick.js — open the native OS "choose folder" dialog on the user's machine and
 * return the selected absolute path.
 *
 * The daemon runs in the user's desktop session, so it can show a real folder
 * picker — letting the browser client obtain a full absolute path without the
 * user typing it (the browser File System Access API can't reveal full paths).
 *
 * Returns one of:
 *   { path: "<abs>" }        a folder was chosen
 *   { canceled: true }       the user dismissed the dialog
 *   { error: "unsupported" } no picker available on this platform (e.g. headless Linux)
 */

const { execFile } = require("child_process");

const DIALOG_TIMEOUT_MS = 5 * 60 * 1000; // user may take a while in the dialog

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: DIALOG_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve({ err, out: (stdout || "").toString() });
    });
  });
}

/** Windows: WinForms FolderBrowserDialog via PowerShell (STA required). */
async function pickWindows() {
  // A background daemon's dialog tends to open BEHIND other windows. To force it
  // to the foreground we create a tiny, invisible, top-most owner form, show +
  // activate it, then open the folder dialog owned by that form.
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.ShowInTaskbar = $false",
    "$owner.StartPosition = 'CenterScreen'",
    "$owner.Width = 1; $owner.Height = 1; $owner.Opacity = 0",
    "$owner.Show(); $owner.Activate(); $owner.BringToFront()",
    // Release always-on-top AFTER foregrounding, so the dialog comes to the
    // front once but doesn't float above other windows when the user switches away.
    "$owner.TopMost = $false",
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$f.Description = 'Select the workspace folder'",
    "$f.ShowNewFolderButton = $true",
    "$res = $f.ShowDialog($owner)",
    "$owner.Close()",
    "if ($res -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }",
  ].join("; ");
  const { out } = await run("powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-Command", ps]);
  const path = out.trim();
  return path ? { path } : { canceled: true };
}

/** macOS: AppleScript "choose folder". */
async function pickMac() {
  const script = 'try\nreturn POSIX path of (choose folder with prompt "Select the workspace folder")\non error number -128\nreturn ""\nend try';
  const { out } = await run("osascript", ["-e", script]);
  const path = out.trim().replace(/\/$/, "");
  return path ? { path } : { canceled: true };
}

/** Linux: zenity directory chooser when available. */
async function pickLinux() {
  const { err, out } = await run("zenity", ["--file-selection", "--directory", "--title=Select the workspace folder"]);
  if (err && err.code === "ENOENT") return { error: "unsupported" };
  const path = out.trim();
  return path ? { path } : { canceled: true };
}

async function pickFolder() {
  try {
    if (process.platform === "win32") return await pickWindows();
    if (process.platform === "darwin") return await pickMac();
    if (process.platform === "linux") return await pickLinux();
    return { error: "unsupported" };
  } catch {
    return { error: "unsupported" };
  }
}

module.exports = { pickFolder };
