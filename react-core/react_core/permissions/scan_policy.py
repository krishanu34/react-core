"""Directory-pruning policy used by workspace_tree, grep_search, file_search.

Three layers, most specific first:
  1. If the caller aimed at a directory (search path, or the fixed prefix of a
     glob), that IS the decision — never prune it.
  2. `include_ignored=True` bypasses every rule below.
  3. Otherwise, prune the project's own ignore-file entries plus a built-in
     noise set (node_modules, dist, .venv, __pycache__, …).

`.git` is never scanned in any mode.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

HARD_SKIP_DIRS = {".git"}

DEFAULT_NOISE_DIRS = {
    # dependencies
    "node_modules", "bower_components", "vendor", "site-packages",
    "jspm_packages", "packages",
    # python envs / caches
    ".venv", "venv", ".virtualenv", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".tox", ".nox", ".eggs",
    # build output
    "dist", "build", "out", "target", "bin", "obj", ".next", ".nuxt",
    ".output", ".svelte-kit", ".turbo", ".parcel-cache", ".gradle",
    # test / coverage
    "coverage", ".nyc_output", "htmlcov",
    # editor / tooling
    ".idea", ".vs", ".vscode-test", ".cache", ".terraform",
}

VISIBLE_DOT_DIRS = {
    ".github", ".gitlab", ".well-known", ".config", ".circleci", ".azure",
    ".husky", ".changeset", ".vscode",
}

IGNORE_FILES = (".gitignore", ".rgignore", ".ignore")
MAX_IGNORE_BYTES = 200_000

_GITIGNORE_DIR = re.compile(r"^/?([A-Za-z0-9._+\-]+)/?$")


def _literal_prefix(pattern: str) -> str:
    """Fixed-text directory prefix of a glob, e.g. `src/**/*.ts` → `src`."""
    if not pattern:
        return ""
    parts: list[str] = []
    for seg in pattern.replace("\\", "/").split("/"):
        if any(ch in seg for ch in "*?["):
            break
        if seg and seg != ".":
            parts.append(seg)
    return "/".join(parts)


def _read_project_noise(root: Path) -> set[str] | None:
    found: set[str] = set()
    for name in IGNORE_FILES:
        p = root / name
        try:
            if not p.is_file() or p.stat().st_size > MAX_IGNORE_BYTES:
                continue
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("!"):
                continue
            m = _GITIGNORE_DIR.match(line)
            if m:
                found.add(m.group(1))
    return found if found else None


class ScanPolicy:
    def __init__(
        self,
        *,
        include_ignored: bool,
        targets: list[str],
        noise_dirs: set[str],
        from_project: bool,
    ):
        self.include_ignored = include_ignored
        self.targets = targets
        self.noise_dirs = noise_dirs
        self.from_project = from_project

    def on_target_path(self, rel_path: str) -> bool:
        rel = rel_path.strip("/")
        for t in self.targets:
            if rel == t or rel.startswith(f"{t}/") or t.startswith(f"{rel}/"):
                return True
        return False

    def skip_dir(self, name: str, rel_path: str) -> bool:
        if name in HARD_SKIP_DIRS:
            return True
        if self.include_ignored:
            return False
        if rel_path and self.on_target_path(rel_path):
            return False
        if name in self.noise_dirs:
            return True
        if name.startswith(".") and name not in VISIBLE_DOT_DIRS:
            return True
        return False

    def describe(self) -> str:
        if self.include_ignored:
            return "searched everything, including dependencies and build output"
        if self.targets:
            return f"targeted {', '.join(self.targets)} (ignore rules bypassed there)"
        source = "the project's ignore files" if self.from_project else "default noise rules"
        return f"skipped dependencies, build output and caches per {source}"


def build(
    root: str | os.PathLike,
    *,
    include_ignored: bool = False,
    search_path: str = "",
    file_pattern: str = "",
) -> ScanPolicy:
    root_p = Path(root)
    targets: list[str] = []
    for candidate in (search_path, _literal_prefix(file_pattern)):
        if not candidate:
            continue
        norm = candidate.replace("\\", "/").strip("/")
        if not norm or norm == "." or os.path.isabs(candidate):
            continue
        if norm not in targets:
            targets.append(norm)

    project_noise = _read_project_noise(root_p)
    noise = set(DEFAULT_NOISE_DIRS)
    if project_noise:
        noise.update(project_noise)

    return ScanPolicy(
        include_ignored=include_ignored,
        targets=targets,
        noise_dirs=noise,
        from_project=project_noise is not None,
    )


INCLUDE_IGNORED_DESCRIPTION = (
    "Set true to search inside dependencies, build output, caches, and other "
    "directories normally skipped by scan policy. Default: false."
)
