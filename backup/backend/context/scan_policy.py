"""
Scan policy — WHICH directories a search tool walks, decided per call.

WHAT WAS WRONG WITH A CONSTANT
Every search tool carried its own frozen `_IGNORE_DIRS` set. Three problems,
all of them the same problem:

  • It was unreachable. "Which version of lodash does this project pin, and
    does the installed copy match?", "the stack trace goes into
    site-packages/urllib3 — show me that frame", "does this vendored SDK
    patch the method we override?" are ordinary brownfield questions, and
    every one of them needs a directory the constant had permanently deleted
    from the agent's world. The agent could not even TRY: no parameter
    existed to say otherwise, so it answered from memory instead of evidence,
    which is the failure mode that reads as hallucination.

  • It was a guess about someone else's project. `build/`, `target/`, `bin/`
    and `dist/` are generated output in most repos and hand-written source in
    plenty of others. A constant cannot tell the difference; the project can,
    and already does — in its .gitignore.

  • It drifted. Five copies of "the same" list, none of them actually the
    same, so a directory hidden from grep was visible to workspace_tree.

WHAT REPLACES IT — three layers, most-specific first

  1. EXPLICIT TARGETING (the model's decision). A directory named in the
     call's `path` or in the literal prefix of its `file_pattern` is scanned,
     full stop. Asking about `node_modules/express` is unambiguous: it is
     already the answer to "should we look there?". This makes the choice
     dynamic without inventing a new mechanism — the model steers by aiming.

  2. `include_ignored=True` (the model's other decision). A survey across
     dependencies, when the model does not yet know which package to aim at.

  3. THE PROJECT'S OWN DECLARATION, then a fallback. .gitignore's directory
     entries are what THIS repo calls noise, so they are used when present.
     The built-in noise set still applies, because brownfield trees are
     routinely handed over as a zip with no .git and no .gitignore, and a
     default of "search node_modules" would bury every result.

`.git` and `.devaccel` are the only unconditional skips: one is VCS plumbing
and the other is our own per-thread scratch space. Neither ever contains an
answer, and both are enormous.
"""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import FrozenSet, Iterable, Optional, Sequence, Set, Tuple

# Never scanned, in any mode. Object databases and our own thread storage:
# huge, binary, and never the answer to a question about the user's code.
HARD_SKIP_DIRS: FrozenSet[str] = frozenset({".git", ".devaccel"})

# Fallback noise set, used when the project does not declare its own. These
# are dependency, build-output and tool-cache directories by strong
# convention — but only by convention, which is why targeting or
# include_ignored overrides every one of them.
DEFAULT_NOISE_DIRS: FrozenSet[str] = frozenset({
    # dependencies
    "node_modules", "bower_components", "vendor", "site-packages",
    "jspm_packages", "packages",
    # python envs / caches
    ".venv", "venv", ".virtualenv", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".tox", ".nox", ".eggs",
    # build output
    "dist", "build", "out", "target", "bin", "obj", ".next", ".nuxt",
    ".output", ".svelte-kit", ".turbo", ".parcel-cache", ".gradle",
    # test/coverage artefacts
    "coverage", ".nyc_output", "htmlcov",
    # editor / OS
    ".idea", ".vs", ".vscode-test", ".cache", ".terraform",
})

# Binary/generated file extensions. Not directories, but the same idea and
# the same need for one definition instead of five.
DEFAULT_NOISE_EXTENSIONS: FrozenSet[str] = frozenset({
    ".pyc", ".pyo", ".pyd", ".class", ".o", ".obj", ".a", ".lib",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm",
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp", ".tif",
    ".mp3", ".mp4", ".wav", ".avi", ".mov", ".webm",
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".pdf", ".sqlite", ".sqlite3", ".db", ".mdb",
    ".map", ".min.js", ".min.css",
})

_IGNORE_FILES = (".gitignore", ".rgignore", ".ignore")

# A .gitignore line that names a DIRECTORY: a plain path segment, optionally
# rooted or trailing-slashed. Patterns with wildcards or multiple segments are
# left alone — resolving them properly means implementing gitignore semantics,
# and a half-implementation that silently hides the wrong folder is worse than
# not reading the file at all.
_GITIGNORE_DIR = re.compile(r"^/?([A-Za-z0-9._+-]+)/?$")

_MAX_IGNORE_BYTES = 200_000


@dataclass(frozen=True)
class ScanPolicy:
    """Immutable per-call decision about what to walk. Build with `build()`."""

    workspace: Path
    include_ignored: bool = False
    # Normalised, POSIX, workspace-relative directory prefixes the caller
    # explicitly aimed at. Anything on the path to or under one of these is
    # scanned even when it would otherwise be skipped.
    targets: Tuple[str, ...] = ()
    noise_dirs: FrozenSet[str] = DEFAULT_NOISE_DIRS
    # True when the noise set came from the project's own ignore files, which
    # is worth reporting: it explains why results differ between two repos.
    from_project: bool = False

    # ── Decisions ────────────────────────────────────────────────────────

    def skip_dir(self, name: str, rel_path: str = "") -> bool:
        """Should the walk prune this directory?

        `rel_path` is the directory's workspace-relative POSIX path. It is
        optional so simple callers can pass a name alone, but passing it is
        what enables targeting — without the path there is no way to tell
        `node_modules` at the root from the one the user asked about.
        """
        if name in HARD_SKIP_DIRS:
            return True
        if self.include_ignored:
            return False
        if rel_path and self._on_target_path(rel_path):
            return False
        if name in self.noise_dirs:
            return True
        # Dotted directories are tool state by convention (.github and friends
        # excepted below). Hidden means "not part of the code you are reading"
        # often enough to be the right default, and targeting still reaches it.
        if name.startswith(".") and name not in _VISIBLE_DOT_DIRS:
            return True
        return False

    def skip_file(self, name: str) -> bool:
        """Binary/generated files. Unlike directories these are cheap to
        re-check per file, and `include_ignored` deliberately does NOT unlock
        them: nobody grepping a dependency wants .pyc hits."""
        lower = name.lower()
        # Two-part suffixes (.min.js) are not what Path.suffix returns.
        for ext in (".min.js", ".min.css"):
            if lower.endswith(ext):
                return True
        return os.path.splitext(lower)[1] in DEFAULT_NOISE_EXTENSIONS

    def _on_target_path(self, rel_path: str) -> bool:
        rel = rel_path.strip("/")
        for t in self.targets:
            # Under a target (the thing asked about), or on the way down to
            # one (so the walk can actually REACH it — pruning `node_modules`
            # when the target is `node_modules/express` would make targeting
            # a no-op).
            if rel == t or rel.startswith(t + "/") or t.startswith(rel + "/"):
                return True
        return False

    # ── Engine adapters ──────────────────────────────────────────────────

    def rg_exclude_globs(self) -> Sequence[str]:
        """Exclusions for ripgrep, as `!**/dir/**`.

        The leading `**` matters: brownfield trees are routinely exported
        without .git, so rg's own gitignore handling never fires, and a bare
        `!node_modules/**` would exclude only the TOP-LEVEL one while
        packages/*/node_modules still floods the results.

        Returns nothing when the caller opted in or aimed somewhere specific —
        in those cases rg is also given `--no-ignore`, so an ignored directory
        is reachable both by our rules and by the project's.
        """
        if self.include_ignored or self.targets:
            return []
        return [f"!**/{d}/**" for d in sorted(self.noise_dirs | set(HARD_SKIP_DIRS))]

    def rg_extra_args(self) -> Sequence[str]:
        """`--no-ignore` is required when opting in: without it rg still
        honours the .gitignore that lists node_modules, and the opt-in would
        appear to do nothing. `.git` stays excluded explicitly."""
        if self.include_ignored or self.targets:
            return ["--no-ignore", "--glob", "!**/.git/**", "--glob", "!**/.devaccel/**"]
        return []

    def describe(self) -> str:
        """One line for the result payload — the user and the model both need
        to know a search was narrowed, or silence reads as absence."""
        if self.include_ignored:
            return "searched everything, including dependencies and build output"
        if self.targets:
            return f"targeted {', '.join(self.targets)} (ignore rules bypassed there)"
        source = "the project's ignore files" if self.from_project else "default noise rules"
        return f"skipped dependencies, build output and caches per {source}"


# `.github` holds workflows people genuinely search for; `.well-known` and
# `.config` likewise carry real project content rather than tool state.
_VISIBLE_DOT_DIRS = frozenset({".github", ".gitlab", ".well-known", ".config",
                               ".circleci", ".azure", ".husky", ".changeset"})


# ── Construction ─────────────────────────────────────────────────────────────

def _read_project_noise(workspace: Path) -> Optional[Set[str]]:
    """Directory names the PROJECT declares as ignorable, or None if it
    declares nothing we can use. Cheap and best-effort — a malformed or
    enormous ignore file just means we fall back."""
    found: Set[str] = set()
    for name in _IGNORE_FILES:
        path = workspace / name
        try:
            if not path.is_file() or path.stat().st_size > _MAX_IGNORE_BYTES:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("!"):
                continue
            m = _GITIGNORE_DIR.match(line)
            if m:
                found.add(m.group(1))
    return found or None


def literal_prefix(pattern: str) -> str:
    """The directory part of a glob that is fixed text.

    `node_modules/express/**/*.js` → `node_modules/express`
    `src/**/*.py`                  → `src`
    `*.py`                         → `` (aims at nothing)

    This is what lets a `file_pattern` unlock a directory: a pattern rooted
    inside a dependency is as explicit a request as passing `path`.
    """
    if not pattern:
        return ""
    norm = pattern.replace("\\", "/")
    parts = []
    for seg in norm.split("/"):
        if any(ch in seg for ch in "*?["):
            break
        parts.append(seg)
    # The last literal segment may be a FILE name rather than a directory
    # (`src/utils/helpers.py`); either way, treating it as a prefix is
    # correct — nothing under a file can be pruned.
    return "/".join(p for p in parts if p and p != ".")


def build(
    workspace: str,
    *,
    include_ignored: bool = False,
    path: Optional[str] = None,
    file_pattern: Optional[str] = None,
    extra_targets: Iterable[str] = (),
) -> ScanPolicy:
    """Assemble the policy for one call.

    `path` and `file_pattern` are the tool's own arguments — passing them is
    what makes targeting work, so every search tool should pass whatever it
    has.
    """
    root = Path(workspace)

    targets = []
    for candidate in (path, literal_prefix(file_pattern or ""), *extra_targets):
        if not candidate:
            continue
        norm = str(candidate).replace("\\", "/").strip("/")
        if not norm or norm == ".":
            continue
        # An absolute path inside the workspace is still targeting; one
        # outside it is not ours to reason about and is ignored.
        if os.path.isabs(norm):
            try:
                norm = str(Path(norm).resolve().relative_to(root.resolve())).replace("\\", "/")
            except (ValueError, OSError):
                continue
            if norm in (".", ""):
                continue
        targets.append(norm)

    project_noise = _read_project_noise(root)
    # The project's list SUPPLEMENTS the default rather than replacing it: a
    # .gitignore that happens not to mention __pycache__ should not make
    # __pycache__ suddenly searchable, and the union is what a developer with
    # both files open would expect.
    noise = frozenset(DEFAULT_NOISE_DIRS | (project_noise or set()))

    return ScanPolicy(
        workspace=root,
        include_ignored=bool(include_ignored),
        targets=tuple(dict.fromkeys(targets)),   # de-duped, order preserved
        noise_dirs=noise,
        from_project=project_noise is not None,
    )


# Description text shared by every tool's `include_ignored` parameter, so the
# model is told the same thing whichever tool it reaches for. Wording matters:
# it has to name the SITUATIONS, because a model that does not recognise when
# the flag applies will never set it.
INCLUDE_IGNORED_DESCRIPTION = (
    "Search inside dependencies, build output and other normally-ignored "
    "directories (node_modules, site-packages, .venv, dist, vendor, …). "
    "Default false. Set true when the question is ABOUT third-party or "
    "generated code — reading a library's actual installed source, checking "
    "what a package really exports, following a stack trace into a "
    "dependency, or confirming a vendored copy was patched. Leave false for "
    "questions about the project's own code, where these directories are "
    "noise. You can also just aim `path`/`file_pattern` at the directory: "
    "targeting one explicitly bypasses the ignore rules for it without "
    "opening up everything else."
)
