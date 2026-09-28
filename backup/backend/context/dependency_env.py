"""
Dependency-environment EVIDENCE — where this project keeps its packages.

WHAT THIS IS NOT
It is not a rule that forces commands into an environment. An earlier version
of this work did exactly that for Python: it detected `pip install`, created
`.venv` and rewrote PATH before every spawn. That was wrong in a way worth
recording, because the same mistake is easy to make again:

  • It only knew Python. A Java project's isolation problem is the Maven local
    repository and a JDK version, a Node project's is `-g` versus local, a Go
    project's is the module cache, Rust's is a workspace target dir, .NET's is
    a global tool versus a local manifest, Ruby's is bundler's path. Those are
    not the same problem with different words — they need different actions.
  • It was a list of Python binaries in a regex, so a Python project using a
    tool nobody listed silently fell through.
  • It made a decision the model was better placed to make. The model can see
    the manifests, the lockfiles, the README and the user's actual request.

So this module ANSWERS A QUESTION instead of enforcing an answer: for each
package ecosystem detected in the workspace, does a project-local dependency
environment already exist, and where would it live? That is a fact. What to
DO about it — create one, reuse it, defer to a manager that owns its own, or
leave it alone because the user asked for a global install — is reasoning,
and it lives in prompts/skills/project_environment.md where the model reads
it.

The split matters: facts a model cannot observe, it cannot reason about. The
model has no cheap way to know that `backend/.venv/pyvenv.cfg` exists or that
`vendor/bundle` is populated, and asking it to go looking costs a tool call
per ecosystem. Handing it the answer up front is what makes the reasoning
possible at all.

ADDING AN ECOSYSTEM
Add a row to `_ECOSYSTEMS`. Detection is by manifest file, so a language this
table has never heard of simply reports nothing rather than reporting
something wrong — silence is the safe failure here.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional


@dataclass
class EnvFinding:
    """One ecosystem's dependency-environment state."""
    ecosystem: str          # "python", "node", "java-maven", …
    manifest: str           # the file that proved the ecosystem is present
    local_env: str = ""     # workspace-relative path to the local env, if any
    isolated: bool = False  # a project-local environment exists
    note: str = ""          # where dependencies go if nothing is done

    def to_dict(self) -> dict:
        out = {
            "ecosystem": self.ecosystem,
            "manifest": self.manifest,
            "isolated": self.isolated,
        }
        if self.local_env:
            out["local_env"] = self.local_env
        if self.note:
            out["note"] = self.note
        return out


# (ecosystem, manifest globs, local-env markers, note-when-absent)
#
# `local_env_markers` are paths RELATIVE to the manifest's directory. A marker
# is a directory or file whose presence means "dependencies are already kept
# inside the project".
#
# `note` says what happens by default when no local environment exists. It is
# descriptive, not prescriptive — several of these defaults are perfectly
# fine, and saying so is as useful as flagging the ones that are not.
_ECOSYSTEMS: List[tuple] = [
    ("python", ["pyproject.toml", "requirements.txt", "requirements-*.txt",
                "setup.py", "setup.cfg", "Pipfile"],
     [".venv", "venv", ".virtualenv", "env"],
     "no virtual environment — pip would install into the machine's global "
     "site-packages, which pollutes the host and leaves the project "
     "unreproducible"),

    ("python-poetry", ["poetry.lock"], [".venv"],
     "poetry manages its own environment; `poetry install` is already isolated"),
    ("python-pipenv", ["Pipfile.lock"], [".venv"],
     "pipenv manages its own environment; `pipenv install` is already isolated"),
    ("python-conda", ["environment.yml", "conda.yaml"], ["envs"],
     "conda manages its own environments; activate the one named in the file"),
    ("python-uv", ["uv.lock"], [".venv"],
     "uv creates and uses .venv itself; `uv sync` is already isolated"),

    ("node", ["package.json"], ["node_modules"],
     "dependencies not installed yet — npm/pnpm/yarn install into ./node_modules "
     "by default, which is already project-local; only `-g` escapes it"),
    ("deno", ["deno.json", "deno.jsonc"], ["vendor"],
     "deno caches dependencies globally by default; `--vendor` keeps them in-project"),

    ("java-maven", ["pom.xml"], [".mvn", "mvnw"],
     "Maven installs into the SHARED ~/.m2 repository; the wrapper (mvnw) pins "
     "the Maven version, and -Dmaven.repo.local scopes the repository"),
    ("java-gradle", ["build.gradle", "build.gradle.kts", "settings.gradle"],
     ["gradlew", "gradle/wrapper"],
     "Gradle caches into the shared ~/.gradle; the wrapper (gradlew) pins the "
     "Gradle version and is the reproducible entry point"),
    ("scala-sbt", ["build.sbt"], ["project/build.properties"],
     "sbt caches into the shared ~/.ivy2 / ~/.cache/coursier"),

    ("dotnet", ["*.csproj", "*.fsproj", "*.sln"],
     [".config/dotnet-tools.json", "packages"],
     "NuGet restores into the shared ~/.nuget/packages; a local tool manifest "
     "(.config/dotnet-tools.json) pins CLI tools per project"),

    ("go", ["go.mod"], ["vendor"],
     "Go uses the shared module cache; `go mod vendor` keeps a copy in-project"),
    ("rust", ["Cargo.toml"], ["vendor", "target"],
     "cargo uses the shared ~/.cargo registry; builds are already per-project "
     "in ./target"),

    ("ruby", ["Gemfile"], ["vendor/bundle", ".bundle"],
     "gems install system-wide unless bundler is pointed at vendor/bundle"),
    ("php", ["composer.json"], ["vendor"],
     "composer installs into ./vendor by default, which is already project-local"),

    ("elixir", ["mix.exs"], ["deps", "_build"],
     "mix keeps deps in ./deps, already project-local"),
    ("dart", ["pubspec.yaml"], [".dart_tool"],
     "pub caches globally; .dart_tool records the project's resolution"),
    ("swift", ["Package.swift"], [".build"],
     "SwiftPM resolves into ./.build, already project-local"),
    ("haskell", ["stack.yaml", "*.cabal"], [".stack-work", "dist-newstyle"],
     "stack/cabal keep build products in-project"),
    ("r", ["renv.lock", "DESCRIPTION"], ["renv"],
     "R installs into a shared library unless renv is initialised"),
    ("perl", ["cpanfile"], ["local"],
     "cpanm installs system-wide unless --local-lib is used"),
]

# Only these many directories are probed below the root. Deep enough for the
# `backend/` + `frontend/` layout the agent itself generates, shallow enough
# that a scan stays cheap on a large repo.
_MAX_DEPTH = 2
_SKIP = {".git", ".devaccel", "node_modules", "__pycache__", ".venv", "venv",
         "dist", "build", "target", "vendor", ".next", ".gradle"}


def _has_marker(base: Path, markers: List[str]) -> Optional[str]:
    for marker in markers:
        candidate = base / marker
        try:
            if candidate.exists():
                return marker
        except OSError:
            continue
    return None


def _matches(base: Path, patterns: List[str]) -> Optional[str]:
    for pattern in patterns:
        try:
            if "*" in pattern:
                hit = next(iter(sorted(base.glob(pattern))), None)
                if hit is not None:
                    return hit.name
            elif (base / pattern).is_file():
                return pattern
        except OSError:
            continue
    return None


def _candidate_dirs(root: Path) -> List[Path]:
    """Root plus its shallow subdirectories — a monorepo keeps one manifest
    per package, and reporting only the root would miss every one of them."""
    dirs = [root]
    frontier = [(root, 0)]
    while frontier:
        current, depth = frontier.pop()
        if depth >= _MAX_DEPTH:
            continue
        try:
            children = [c for c in current.iterdir() if c.is_dir()]
        except OSError:
            continue
        for child in sorted(children):
            if child.name in _SKIP or child.name.startswith("."):
                continue
            dirs.append(child)
            frontier.append((child, depth + 1))
    return dirs


def detect(workspace: str) -> List[EnvFinding]:
    """Report every package ecosystem present and whether it is isolated.

    Returns [] for a workspace with no recognised manifests — an empty answer
    is correct there, and better than a guess.
    """
    root = Path(workspace)
    if not root.is_dir():
        return []

    findings: Dict[str, EnvFinding] = {}
    for base in _candidate_dirs(root):
        try:
            rel_base = base.relative_to(root).as_posix()
        except ValueError:
            continue
        rel_base = "" if rel_base == "." else rel_base

        for ecosystem, manifests, markers, note in _ECOSYSTEMS:
            manifest = _matches(base, manifests)
            if not manifest:
                continue
            marker = _has_marker(base, markers)
            key = f"{ecosystem}@{rel_base}"
            # First finding for an ecosystem+dir wins; an ISOLATED one always
            # replaces a non-isolated one, so `poetry.lock` beside
            # `requirements.txt` does not report the project as unmanaged.
            existing = findings.get(key)
            if existing and (existing.isolated or not marker):
                continue
            findings[key] = EnvFinding(
                ecosystem=ecosystem,
                manifest=f"{rel_base}/{manifest}" if rel_base else manifest,
                local_env=(f"{rel_base}/{marker}" if rel_base and marker else (marker or "")),
                isolated=bool(marker),
                note="" if marker else note,
            )

    return sorted(findings.values(), key=lambda f: (f.ecosystem, f.manifest))


def as_prompt_lines(findings: List[EnvFinding]) -> str:
    """One block for the project-context prompt. Empty when nothing was found,
    so a workspace with no manifests costs no tokens."""
    if not findings:
        return ""
    lines = []
    for f in findings:
        if f.isolated:
            lines.append(f"  {f.ecosystem} ({f.manifest}) — project-local env at {f.local_env}")
        else:
            lines.append(f"  {f.ecosystem} ({f.manifest}) — {f.note}")
    return "Dependency environments:\n" + "\n".join(lines)
