"""Runtime detection + fresh PATH resolution.

A running process keeps the PATH it was started with, so a runtime installed
mid-session is invisible to naïve `shutil.which` — unless we re-read PATH
from the OS. That's what `fresh_path()` does:
  - Windows: HKLM + HKCU environment keys via winreg, %VAR% expansion.
  - POSIX: login-shell PATH via `$SHELL -lc 'printf %s "$PATH"'`.

`missing_runtime()` returns a structured `runtime_missing` result so the
agent can tell the user exactly what to install, matching the daemon's
old contract.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import time

IS_WIN = sys.platform == "win32"

KNOWN_RUNTIMES: dict[str, dict[str, str]] = {
    "node":     {"runtime": "Node.js",   "install": "https://nodejs.org (LTS)"},
    "npm":      {"runtime": "Node.js",   "install": "https://nodejs.org (npm ships with Node.js)"},
    "npx":      {"runtime": "Node.js",   "install": "https://nodejs.org (npx ships with Node.js)"},
    "yarn":     {"runtime": "Yarn",      "install": "`npm install -g yarn`"},
    "pnpm":     {"runtime": "pnpm",      "install": "`npm install -g pnpm`"},
    "python":   {"runtime": "Python",    "install": "https://python.org/downloads"},
    "python3":  {"runtime": "Python",    "install": "https://python.org/downloads"},
    "pip":      {"runtime": "Python",    "install": "https://python.org/downloads (pip ships with Python)"},
    "pip3":     {"runtime": "Python",    "install": "https://python.org/downloads (pip ships with Python)"},
    "java":     {"runtime": "Java JDK",  "install": "https://adoptium.net"},
    "javac":    {"runtime": "Java JDK",  "install": "https://adoptium.net"},
    "mvn":      {"runtime": "Maven",     "install": "https://maven.apache.org/install.html"},
    "gradle":   {"runtime": "Gradle",    "install": "https://gradle.org/install"},
    "go":       {"runtime": "Go",        "install": "https://go.dev/dl"},
    "cargo":    {"runtime": "Rust",      "install": "https://rustup.rs"},
    "rustc":    {"runtime": "Rust",      "install": "https://rustup.rs"},
    "dotnet":   {"runtime": ".NET SDK",  "install": "https://dotnet.microsoft.com/download"},
    "php":      {"runtime": "PHP",       "install": "https://www.php.net/downloads"},
    "composer": {"runtime": "Composer",  "install": "https://getcomposer.org/download"},
    "ruby":     {"runtime": "Ruby",      "install": "https://www.ruby-lang.org/en/downloads"},
    "gem":      {"runtime": "Ruby",      "install": "https://www.ruby-lang.org/en/downloads"},
    "bundle":   {"runtime": "Bundler",   "install": "`gem install bundler`"},
    "git":      {"runtime": "Git",       "install": "https://git-scm.com/downloads"},
    "docker":   {"runtime": "Docker",    "install": "https://docs.docker.com/get-docker"},
    "kubectl":  {"runtime": "kubectl",   "install": "https://kubernetes.io/docs/tasks/tools"},
    "terraform": {"runtime": "Terraform", "install": "https://developer.hashicorp.com/terraform/install"},
}

_PATH_TTL_S = 60.0
_cached_path: tuple[str, float] | None = None

_PROBE_MISS_TTL = 60.0
_probe_cache: dict[str, tuple[bool, float]] = {}


def _windows_registry_path() -> str:
    try:
        import winreg
    except ImportError:  # pragma: no cover
        return ""

    def _read(root, sub) -> str:
        try:
            with winreg.OpenKey(root, sub) as k:
                val, _ = winreg.QueryValueEx(k, "Path")
                return str(val or "")
        except OSError:
            return ""

    system = _read(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
    user = _read(winreg.HKEY_CURRENT_USER, r"Environment")
    raw = ";".join(p for p in (system, user) if p)

    def _expand(match: re.Match) -> str:
        name = match.group(1)
        return os.environ.get(name, match.group(0))

    return re.sub(r"%([^%;]+)%", _expand, raw)


def _posix_login_shell_path() -> str:
    shell = os.environ.get("SHELL", "/bin/sh")
    try:
        r = subprocess.run(
            [shell, "-lc", 'printf %s "$PATH"'],
            capture_output=True, timeout=5.0, text=True,
        )
        if r.returncode == 0:
            return (r.stdout or "").strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return ""


def fresh_path() -> str:
    """Return a PATH that includes runtimes installed after this process started."""
    global _cached_path
    now = time.monotonic()
    if _cached_path and (now - _cached_path[1]) < _PATH_TTL_S:
        return _cached_path[0]
    sep = ";" if IS_WIN else ":"
    current = os.environ.get("PATH") or os.environ.get("Path") or ""
    extra = _windows_registry_path() if IS_WIN else _posix_login_shell_path()
    seen: set[str] = set()
    merged: list[str] = []
    for candidate in current.split(sep) + extra.split(sep):
        p = candidate.strip()
        if not p:
            continue
        key = p.lower() if IS_WIN else p
        if key in seen:
            continue
        seen.add(key)
        merged.append(p)
    result = sep.join(merged) or current
    _cached_path = (result, now)
    return result


def binary_on_path(name: str) -> bool:
    now = time.monotonic()
    hit = _probe_cache.get(name)
    if hit is not None:
        found, at = hit
        if found or (now - at) < _PROBE_MISS_TTL:
            return found
    env = {**os.environ, "PATH": fresh_path()}
    found = shutil.which(name, path=env["PATH"]) is not None
    _probe_cache[name] = (found, now)
    return found


def leading_binaries(command: str) -> list[str]:
    segments = re.split(r"&&|\|\||[;|]", command)
    out: list[str] = []
    for seg in segments:
        seg = seg.strip()
        if not seg:
            continue
        first = seg.split()[0].lower()
        first = re.sub(r"\.(exe|cmd|bat)$", "", first)
        out.append(first)
    return out


def missing_runtime(command: str) -> dict[str, str] | None:
    for bin_name in leading_binaries(command):
        known = KNOWN_RUNTIMES.get(bin_name)
        if known and not binary_on_path(bin_name):
            return {
                "error": "runtime_missing",
                "runtime": known["runtime"],
                "binary": bin_name,
                "command": command,
                "suggestion": (
                    f"'{bin_name}' is not on PATH (checked the merged fresh PATH). "
                    f"Install {known['runtime']}: {known['install']}. Then retry — "
                    f"no restart needed."
                ),
            }
    return None


def check_runtimes(binaries: list[str] | None = None) -> dict[str, dict[str, str | bool | None]]:
    result: dict[str, dict[str, str | bool | None]] = {}
    for raw in (binaries or list(KNOWN_RUNTIMES.keys())):
        name = raw.strip().lower()
        if not re.fullmatch(r"[a-z0-9._-]{1,32}", name):
            continue
        if binary_on_path(name):
            result[name] = {"available": True, "version": _runtime_version(name)}
        else:
            known = KNOWN_RUNTIMES.get(name)
            entry: dict[str, str | bool | None] = {"available": False}
            if known:
                entry.update(known)
            result[name] = entry
    return result


_VERSION_ARGS = {"java": ["-version"], "go": ["version"]}


def _runtime_version(name: str) -> str | None:
    args = _VERSION_ARGS.get(name, ["--version"])
    env = {**os.environ, "PATH": fresh_path()}
    try:
        r = subprocess.run(
            [name, *args],
            capture_output=True, timeout=3.0, text=True, env=env,
            shell=IS_WIN,
        )
        out = f"{r.stdout or ''} {r.stderr or ''}".strip()
        m = re.search(r"\d+(\.\d+)+", out)
        if m:
            return m.group(0)
        return (out.splitlines()[0][:40]) if out else None
    except (OSError, subprocess.TimeoutExpired):
        return None
