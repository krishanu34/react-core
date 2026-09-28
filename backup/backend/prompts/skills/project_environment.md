---
name: project_environment
description: Decide where a project's dependencies and toolchain should live before installing anything — virtual environments, local package directories, version managers, wrappers and lockfiles, across any language. Use when installing or adding a dependency, scaffolding a new project, running a build or test suite for the first time, or when a command failed because a package or runtime was missing.
---

## Where do this project's dependencies go?

Answer this **before** the first install command, not after. The wrong answer
is expensive in a way that shows up much later: dependencies land on the
machine instead of in the project, the build works for the person who ran it
and nobody else, and the project has no record of what it actually needs.

There is no single correct action, because the isolation mechanism is
different in every ecosystem — a virtual environment, a local package
directory, a wrapper script, a lockfile, a version manager, or nothing at all
because the tool already isolates by default. Pick the one that belongs to the
ecosystem in front of you.

### Step 1 — Read the evidence you already have

`project_context` reports a **Dependency environments** block: every package
ecosystem detected in the workspace, whether a project-local environment
already exists, and where dependencies would go if you do nothing. Read it
first. It is cheaper and more reliable than guessing from the file tree, and
in a monorepo it tells you which *subdirectory* each ecosystem lives in.

If that block is missing or the workspace is empty (a greenfield scaffold),
work from the manifest you are about to create.

### Step 2 — Apply the ecosystem's own convention

The question is always the same — *does an install command reach outside this
project?* — and the answer differs:

| Ecosystem | Signal | Default reach | Do this |
|---|---|---|---|
| **Python (pip)** | `requirements*.txt`, `setup.py`, `pyproject.toml` | **Global** site-packages | Create and use a venv: `python -m venv .venv`, then call its interpreter directly (`.venv/bin/python -m pip install …`, `.venv\Scripts\python -m pip install …`). Do NOT rely on `activate` — each command runs in a fresh shell, so activation does not persist between calls |
| **Python (poetry / pipenv / uv / conda / hatch / pdm)** | `poetry.lock`, `Pipfile`, `uv.lock`, `environment.yml` | Managed | Use the manager's own command (`poetry install`, `uv sync`). It creates and selects its environment; adding a venv beside it gives the project two |
| **Node / TypeScript** | `package.json` | Local `./node_modules` | Already isolated. Just `npm ci` / `npm install`. Never `-g` for a project dependency — a global install is invisible to the project's manifest |
| **Deno** | `deno.json` | Global cache | Fine by default; use `--vendor` or a lockfile when reproducibility is required |
| **Java (Maven)** | `pom.xml` | **Shared `~/.m2`** | Prefer the wrapper `./mvnw` — it pins the Maven version. Scope the repository with `-Dmaven.repo.local=.m2` when the build must not touch the shared one. Pin the JDK via `maven.compiler.release` / toolchains, not the ambient `JAVA_HOME` |
| **Java / Kotlin (Gradle)** | `build.gradle[.kts]` | **Shared `~/.gradle`** | Use `./gradlew`, never a system `gradle` — the wrapper is the reproducible entry point and downloads the pinned version itself |
| **Scala (sbt)** | `build.sbt` | Shared ivy/coursier | Pin the sbt version in `project/build.properties` |
| **.NET** | `*.csproj`, `*.sln` | Shared `~/.nuget` | `dotnet restore` is fine. For CLI tools use a **local tool manifest** (`dotnet new tool-manifest` → `dotnet tool install`), not `-g`. Pin the SDK in `global.json` |
| **Go** | `go.mod` | Shared module cache | Fine by default — the module graph is pinned in `go.mod`/`go.sum`. Use `go mod vendor` only if the build must be offline/hermetic. `go install` puts BINARIES on the machine; that is a tool, not a dependency |
| **Rust** | `Cargo.toml` | Shared registry, per-project `./target` | Fine by default. Pin the toolchain in `rust-toolchain.toml`. `cargo install` is a machine-level tool install — treat it as such |
| **Ruby** | `Gemfile` | **System gems** | `bundle config set --local path vendor/bundle` then `bundle install`, so gems land in the project |
| **PHP** | `composer.json` | Local `./vendor` | Already isolated. `composer install` |
| **Elixir** | `mix.exs` | Local `./deps` | Already isolated. `mix deps.get` |
| **Dart / Flutter** | `pubspec.yaml` | Global pub cache | Resolution is pinned by `pubspec.lock`; that is usually enough |
| **Swift** | `Package.swift` | Local `./.build` | Already isolated |
| **R** | `DESCRIPTION`, `renv.lock` | Shared library | `renv::init()` / `renv::restore()` for a project library |
| **Perl** | `cpanfile` | System | `cpanm --local-lib=local --installdeps .` |
| **Haskell** | `stack.yaml`, `*.cabal` | In-project build dir | Already isolated |
| **System packages** (`apt`, `brew`, `choco`, `winget`) | — | **The whole machine** | Not a project dependency. Only when the user asked for it, and say what it changes |

If the ecosystem is not in this table, reason from the same question rather
than forcing the nearest row: find the package manager, check its
documentation or `--help` for a project-local install path, and prefer it. A
language nobody listed is not a reason to fall back to a global install.

### Step 3 — Make the choice reproducible

An isolated install that nobody can repeat has solved half the problem.

- **Record the dependency in the manifest**, not just in the environment.
  `pip install X` without adding X to `requirements.txt`/`pyproject.toml`
  leaves the next person with a broken checkout.
- **Commit the lockfile** when the ecosystem has one.
- **Say it in the README**: the exact commands to create the environment and
  install dependencies on a fresh machine, for the OS the user is on.
- **Add the environment directory to `.gitignore`** (`.venv/`, `node_modules/`,
  `vendor/bundle/`, `target/`). Committing it is a different failure with the
  same cause.

### Step 4 — Tell the user what you did to their machine

If you created an environment, installed a system package, or wrote a
lockfile, say so in the answer — briefly, once. A directory appearing with no
explanation reads as a bug.

## Failure modes worth recognising

- **`pip install` succeeded but the import still fails.** Two interpreters.
  You installed with one `python` and ran with another. Call the environment's
  interpreter explicitly by path.
- **`activate` appears to do nothing.** Each `run_terminal` call is a separate
  shell; shell state does not survive between calls. Use the absolute path to
  the environment's interpreter or the manager's `run` subcommand
  (`poetry run`, `npm exec`, `./gradlew`) instead.
- **"Command not found" right after installing it.** The tool went to a
  directory that is not on this shell's PATH. Invoke it by path, or through
  the ecosystem's runner.
- **Permission denied on install.** A sign the install was heading somewhere
  global. That is the signal to switch to a project-local install, not to
  reach for `sudo`.
- **Works here, fails in CI.** Something was installed on the machine and
  never written down. Go back to Step 3.
