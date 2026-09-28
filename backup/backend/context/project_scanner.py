"""
Project Scanner — Language-Agnostic Workspace Understanding

This is the "Gather Context" phase from the agentic loop:
  Your prompt → [Gather Context] → Take Action → Verify → Done

Before the agent starts reasoning, the scanner reads high-signal
entry-point files to build a ProjectContext object that tells the
agent: what language, what framework, how to build/test/lint, what
the directory structure means, and what conventions to follow.

This is how Claude Code, Copilot, and Cursor understand any project
in seconds — not by parsing ASTs or building indexes, but by reading
a few key files that every project has.

The technique:
  1. Check for manifest files (package.json, Cargo.toml, go.mod...)
     → detects language + dependencies + scripts
  2. Read high-signal files (README, Dockerfile, Makefile...)
     → discovers build commands, architecture notes
  3. Map directory names to architectural roles
     → src/ = source, tests/ = tests, routes/ = API layer
  4. Check for AI instruction files (CLAUDE.md, .cursorrules...)
     → project-specific agent instructions

Results are cached per workspace path — scanning only happens once
per directory, not on every request.
"""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple


@dataclass
class ProjectContext:
    """Everything the agent needs to know about a workspace."""

    workspace_path: str

    # Language detection
    languages: List[str] = field(default_factory=list)
    primary_language: str = ""

    # Framework / runtime
    frameworks: List[str] = field(default_factory=list)
    runtime: str = ""

    # Commands discovered from manifest/Makefile/scripts
    build_command: str = ""
    test_command: str = ""
    lint_command: str = ""
    run_command: str = ""
    install_command: str = ""

    # Dependencies (top-level only, not the full tree)
    key_dependencies: List[str] = field(default_factory=list)

    # Directory structure roles
    directory_roles: Dict[str, str] = field(default_factory=dict)

    # Project metadata
    project_name: str = ""
    description: str = ""
    entry_point: str = ""

    # AI instruction files found
    ai_instructions: str = ""

    # High-signal file contents (README snippet, etc.)
    readme_summary: str = ""

    # Raw manifest data for the agent to reference
    manifest_file: str = ""
    manifest_type: str = ""

    # Where each detected ecosystem keeps its dependencies, and whether a
    # project-local environment already exists. EVIDENCE, not policy: what to
    # do about it is the model's call, guided by the `project_environment`
    # skill. See context/dependency_env.py for why it is split that way.
    dependency_environments: List[dict] = field(default_factory=list)

    def as_prompt_context(self) -> str:
        """Format as text block for injection into agent prompts."""
        sections = []

        sections.append(f"Project: {self.project_name or 'Unknown'}")
        if self.description:
            sections.append(f"Description: {self.description}")

        if self.primary_language:
            lang_str = self.primary_language
            if len(self.languages) > 1:
                lang_str += f" (also: {', '.join(self.languages[1:])})"
            sections.append(f"Language: {lang_str}")

        if self.frameworks:
            sections.append(f"Framework: {', '.join(self.frameworks)}")

        if self.runtime:
            sections.append(f"Runtime: {self.runtime}")

        # Commands
        cmds = []
        if self.install_command:
            cmds.append(f"  Install: {self.install_command}")
        if self.build_command:
            cmds.append(f"  Build: {self.build_command}")
        if self.run_command:
            cmds.append(f"  Run: {self.run_command}")
        if self.test_command:
            cmds.append(f"  Test: {self.test_command}")
        if self.lint_command:
            cmds.append(f"  Lint: {self.lint_command}")
        if cmds:
            sections.append("Commands:\n" + "\n".join(cmds))

        if self.entry_point:
            sections.append(f"Entry point: {self.entry_point}")

        if self.key_dependencies:
            sections.append(f"Key dependencies: {', '.join(self.key_dependencies[:15])}")

        if self.directory_roles:
            role_lines = [f"  {d}/ = {role}" for d, role in sorted(self.directory_roles.items())]
            sections.append("Directory structure:\n" + "\n".join(role_lines))

        if self.ai_instructions:
            # Truncate to avoid eating too much context budget
            instructions = self.ai_instructions[:500]
            if len(self.ai_instructions) > 500:
                instructions += "\n[...truncated, see CLAUDE.md for full instructions]"
            sections.append(f"Project instructions:\n{instructions}")

        if self.dependency_environments:
            from .dependency_env import EnvFinding, as_prompt_lines
            block = as_prompt_lines([
                EnvFinding(
                    ecosystem=e.get("ecosystem", ""), manifest=e.get("manifest", ""),
                    local_env=e.get("local_env", ""), isolated=e.get("isolated", False),
                    note=e.get("note", ""),
                )
                for e in self.dependency_environments
            ])
            if block:
                sections.append(block)

        if self.readme_summary:
            sections.append(f"README summary: {self.readme_summary}")

        return "\n".join(sections)

    def to_dict(self) -> dict:
        return {
            "workspace_path": self.workspace_path,
            "project_name": self.project_name,
            "description": self.description,
            "primary_language": self.primary_language,
            "languages": self.languages,
            "frameworks": self.frameworks,
            "runtime": self.runtime,
            "build_command": self.build_command,
            "test_command": self.test_command,
            "lint_command": self.lint_command,
            "run_command": self.run_command,
            "install_command": self.install_command,
            "entry_point": self.entry_point,
            "key_dependencies": self.key_dependencies,
            "directory_roles": self.directory_roles,
            "manifest_file": self.manifest_file,
            "manifest_type": self.manifest_type,
            "dependency_environments": self.dependency_environments,
        }


# ── Cache ───────────────────────────────────────────────────────
# One scan per workspace path per process lifetime.

_cache: Dict[str, ProjectContext] = {}


def scan_project(workspace_path: str, force: bool = False) -> ProjectContext:
    """
    Scan a workspace and return a ProjectContext.
    Cached — subsequent calls for the same path return instantly.
    """
    workspace_path = str(Path(workspace_path).resolve())

    if not force and workspace_path in _cache:
        return _cache[workspace_path]

    ctx = ProjectContext(workspace_path=workspace_path)
    root = Path(workspace_path)

    if not root.is_dir():
        return ctx

    # Phase 1: Detect manifest files → language + framework + commands
    _detect_manifest(root, ctx)

    # Phase 2: Map directory structure to roles
    _detect_directory_roles(root, ctx)

    # Phase 3: Read high-signal files (README, AI instructions)
    _read_high_signal_files(root, ctx)

    # Phase 4: Detect entry point
    _detect_entry_point(root, ctx)

    # Phase 5: Where does each ecosystem keep its dependencies, and is there
    # already a project-local environment? Facts only — the agent decides what
    # to do with them (prompts/skills/project_environment.md). A model cannot
    # reason about a .venv it has no cheap way to observe.
    try:
        from .dependency_env import detect as _detect_envs
        ctx.dependency_environments = [f.to_dict() for f in _detect_envs(workspace_path)]
    except Exception as e:  # noqa: BLE001 — context must never fail a run
        log.debug(f"Dependency environment scan skipped: {e}")

    # Cache it
    _cache[workspace_path] = ctx
    return ctx


def invalidate_cache(workspace_path: str = None):
    """Clear cached scan results. None = clear all."""
    if workspace_path:
        _cache.pop(str(Path(workspace_path).resolve()), None)
    else:
        _cache.clear()


# ── Phase 1: Manifest Detection ────────────────────────────────

# (manifest_filename, language, manifest_type)
_MANIFEST_FILES: List[Tuple[str, str, str]] = [
    # JavaScript / TypeScript
    ("package.json", "JavaScript", "npm"),
    ("tsconfig.json", "TypeScript", "typescript"),
    ("deno.json", "TypeScript", "deno"),
    ("deno.jsonc", "TypeScript", "deno"),
    ("bun.lockb", "TypeScript", "bun"),
    # Python
    ("pyproject.toml", "Python", "pyproject"),
    ("requirements.txt", "Python", "pip"),
    ("setup.py", "Python", "setuptools"),
    ("setup.cfg", "Python", "setuptools"),
    ("Pipfile", "Python", "pipenv"),
    ("poetry.lock", "Python", "poetry"),
    ("conda.yaml", "Python", "conda"),
    ("environment.yml", "Python", "conda"),
    # Rust
    ("Cargo.toml", "Rust", "cargo"),
    # Go
    ("go.mod", "Go", "gomod"),
    # JVM
    ("pom.xml", "Java", "maven"),
    ("build.gradle", "Java", "gradle"),
    ("build.gradle.kts", "Kotlin", "gradle"),
    ("build.sbt", "Scala", "sbt"),
    ("deps.edn", "Clojure", "clojure-deps"),
    ("project.clj", "Clojure", "leiningen"),
    ("build.boot", "Clojure", "boot"),
    # .NET
    ("*.csproj", "C#", "dotnet"),
    ("*.fsproj", "F#", "dotnet"),
    ("*.vbproj", "Visual Basic", "dotnet"),
    ("*.sln", "", "dotnet"),
    ("Directory.Build.props", "", "dotnet"),
    ("global.json", "", "dotnet"),
    # Ruby
    ("Gemfile", "Ruby", "bundler"),
    # PHP
    ("composer.json", "PHP", "composer"),
    # Swift / Objective-C / Apple
    ("Package.swift", "Swift", "swift-pm"),
    ("Podfile", "Objective-C", "cocoapods"),
    # Dart / Flutter
    ("pubspec.yaml", "Dart", "pub"),
    # Elixir / Erlang
    ("mix.exs", "Elixir", "mix"),
    ("rebar.config", "Erlang", "rebar"),
    ("rebar.lock", "Erlang", "rebar"),
    # Haskell
    ("stack.yaml", "Haskell", "stack"),
    ("cabal.project", "Haskell", "cabal"),
    # C / C++
    ("CMakeLists.txt", "C/C++", "cmake"),
    ("meson.build", "C/C++", "meson"),
    ("conanfile.txt", "C/C++", "conan"),
    ("conanfile.py", "C/C++", "conan"),
    ("vcpkg.json", "C/C++", "vcpkg"),
    ("Makefile", "", "make"),
    # Zig
    ("build.zig", "Zig", "zig"),
    ("build.zig.zon", "Zig", "zig"),
    # Nim
    ("*.nimble", "Nim", "nimble"),
    # OCaml / ReasonML
    ("dune-project", "OCaml", "dune"),
    ("esy.json", "OCaml", "esy"),
    # Crystal
    ("shard.yml", "Crystal", "shards"),
    # V
    ("v.mod", "V", "vpm"),
    # D
    ("dub.json", "D", "dub"),
    ("dub.sdl", "D", "dub"),
    # Julia
    ("Project.toml", "Julia", "julia-pkg"),
    # R
    ("DESCRIPTION", "R", "r-pkg"),
    ("renv.lock", "R", "renv"),
    # Perl
    ("cpanfile", "Perl", "cpan"),
    ("Makefile.PL", "Perl", "perl-make"),
    ("dist.ini", "Perl", "dist-zilla"),
    # Lua
    ("*.rockspec", "Lua", "luarocks"),
    # Fortran
    ("fpm.toml", "Fortran", "fpm"),
    # Solidity / Web3
    ("hardhat.config.js", "Solidity", "hardhat"),
    ("hardhat.config.ts", "Solidity", "hardhat"),
    ("truffle-config.js", "Solidity", "truffle"),
    ("foundry.toml", "Solidity", "foundry"),
    ("Move.toml", "Move", "move"),
    ("Scarb.toml", "Cairo", "scarb"),
    # Build systems / IaC
    ("BUILD", "", "bazel"),
    ("WORKSPACE", "", "bazel"),
    ("flake.nix", "Nix", "nix"),
    ("default.nix", "Nix", "nix"),
    ("Earthfile", "", "earthly"),
    ("Justfile", "", "just"),
    ("Taskfile.yml", "", "task"),
    ("Tiltfile", "", "tilt"),
    # Terraform / Pulumi
    ("main.tf", "HCL", "terraform"),
    ("Pulumi.yaml", "", "pulumi"),
    # Android
    ("settings.gradle", "Java", "gradle"),
    ("settings.gradle.kts", "Kotlin", "gradle"),
    # Protobuf / gRPC
    ("buf.yaml", "Protobuf", "buf"),
    # WASM
    ("trunk.toml", "Rust", "trunk"),
]

# framework name → detection key (in dependency names)
_FRAMEWORK_SIGNALS: Dict[str, List[str]] = {
    # Python
    "FastAPI": ["fastapi"],
    "Django": ["django"],
    "Flask": ["flask"],
    "Starlette": ["starlette"],
    "Tornado": ["tornado"],
    "aiohttp": ["aiohttp"],
    "Celery": ["celery"],
    "SQLAlchemy": ["sqlalchemy"],
    "Pydantic": ["pydantic"],
    "Scrapy": ["scrapy"],
    "Pytest": ["pytest"],
    "NumPy": ["numpy"],
    "Pandas": ["pandas"],
    "TensorFlow": ["tensorflow"],
    "PyTorch": ["torch"],
    "Streamlit": ["streamlit"],
    "Gradio": ["gradio"],
    "LangChain": ["langchain"],
    "Hugging Face": ["transformers"],
    # JavaScript/TypeScript
    "React": ["react"],
    "Next.js": ["next"],
    "Vue": ["vue"],
    "Nuxt": ["nuxt"],
    "Angular": ["@angular/core"],
    "Express": ["express"],
    "NestJS": ["@nestjs/core"],
    "Fastify": ["fastify"],
    "Svelte": ["svelte"],
    "SvelteKit": ["@sveltejs/kit"],
    "Remix": ["@remix-run/react"],
    "Astro": ["astro"],
    "Hono": ["hono"],
    "Koa": ["koa"],
    "Electron": ["electron"],
    "React Native": ["react-native"],
    "Expo": ["expo"],
    "Three.js": ["three"],
    "Vite": ["vite"],
    "Webpack": ["webpack"],
    "Tailwind CSS": ["tailwindcss"],
    "Prisma": ["prisma", "@prisma/client"],
    "Drizzle": ["drizzle-orm"],
    "tRPC": ["@trpc/server"],
    "Zod": ["zod"],
    "Jest": ["jest"],
    "Vitest": ["vitest"],
    "Playwright": ["@playwright/test", "playwright"],
    "Cypress": ["cypress"],
    "Storybook": ["@storybook/react"],
    # Go
    "Gin": ["gin"],
    "Echo": ["echo"],
    "Fiber": ["fiber"],
    "Chi": ["chi"],
    "GORM": ["gorm"],
    "Gorilla Mux": ["mux"],
    "gRPC-Go": ["grpc"],
    # Rust
    "Actix": ["actix-web"],
    "Axum": ["axum"],
    "Rocket": ["rocket"],
    "Tokio": ["tokio"],
    "Diesel": ["diesel"],
    "SeaORM": ["sea-orm"],
    "Tauri": ["tauri"],
    "Leptos": ["leptos"],
    "Yew": ["yew"],
    "Bevy": ["bevy"],
    # Java / Kotlin
    "Spring Boot": ["spring-boot", "spring-boot-starter"],
    "Quarkus": ["quarkus"],
    "Micronaut": ["micronaut"],
    "Ktor": ["ktor"],
    "Android": ["androidx"],
    "JUnit": ["junit"],
    "Hibernate": ["hibernate"],
    # Ruby
    "Rails": ["rails"],
    "Sinatra": ["sinatra"],
    "RSpec": ["rspec"],
    "Hanami": ["hanami"],
    # PHP
    "Laravel": ["laravel"],
    "Symfony": ["symfony"],
    "WordPress": ["wordpress"],
    "PHPUnit": ["phpunit"],
    # Swift
    "SwiftUI": ["swiftui"],
    "Vapor": ["vapor"],
    # Dart
    "Flutter": ["flutter"],
    # Elixir
    "Phoenix": ["phoenix"],
    "Ecto": ["ecto"],
    # Scala
    "Akka": ["akka"],
    "Play Framework": ["play"],
    "ZIO": ["zio"],
    # C# / .NET
    "ASP.NET": ["microsoft.aspnetcore"],
    "Entity Framework": ["microsoft.entityframeworkcore"],
    "Blazor": ["microsoft.aspnetcore.components"],
    "MAUI": ["microsoft.maui"],
    "xUnit": ["xunit"],
    "NUnit": ["nunit"],
    # Haskell
    "Yesod": ["yesod"],
    "Servant": ["servant"],
    # Clojure
    "Ring": ["ring"],
    "Compojure": ["compojure"],
    "Re-frame": ["re-frame"],
    # Solidity
    "OpenZeppelin": ["openzeppelin"],
    "Hardhat": ["hardhat"],
    "Foundry": ["forge-std"],
}


def _detect_manifest(root: Path, ctx: ProjectContext):
    """Read manifest files to detect language, framework, commands."""
    found_languages = set()

    for manifest_name, language, manifest_type in _MANIFEST_FILES:
        # Support glob patterns (e.g., "*.csproj", "*.nimble")
        if "*" in manifest_name:
            matches = list(root.glob(manifest_name))
            if not matches:
                continue
            manifest_path = matches[0]
            manifest_name = manifest_path.name
        else:
            manifest_path = root / manifest_name
            if not manifest_path.exists():
                continue

        if language:
            found_languages.add(language)

        if not ctx.manifest_file:
            ctx.manifest_file = manifest_name
            ctx.manifest_type = manifest_type

        # Parse specific manifest types for richer data
        if manifest_name == "package.json":
            _parse_package_json(manifest_path, ctx)
        elif manifest_name == "pyproject.toml":
            _parse_pyproject_toml(manifest_path, ctx)
        elif manifest_name == "requirements.txt":
            _parse_requirements_txt(manifest_path, ctx)
        elif manifest_name == "Cargo.toml":
            _parse_cargo_toml(manifest_path, ctx)
        elif manifest_name == "go.mod":
            _parse_go_mod(manifest_path, ctx)
        elif manifest_name == "Gemfile":
            _parse_gemfile(manifest_path, ctx)
        elif manifest_name == "composer.json":
            _parse_composer_json(manifest_path, ctx)
        elif manifest_name == "pubspec.yaml":
            _parse_pubspec_yaml(manifest_path, ctx)

    # Check for tsconfig to upgrade JS → TS
    if (root / "tsconfig.json").exists():
        found_languages.discard("JavaScript")
        found_languages.add("TypeScript")

    ctx.languages = sorted(found_languages)
    if ctx.languages:
        ctx.primary_language = ctx.languages[0]

    # Detect install command from manifest type
    if not ctx.install_command:
        install_cmds = {
            "npm": "npm install",
            "pip": "pip install -r requirements.txt",
            "pyproject": "pip install -e .",
            "poetry": "poetry install",
            "pipenv": "pipenv install",
            "conda": "conda env create -f environment.yml",
            "cargo": "cargo build",
            "gomod": "go mod download",
            "maven": "mvn install",
            "gradle": "./gradlew build",
            "bundler": "bundle install",
            "composer": "composer install",
            "pub": "dart pub get",
            "mix": "mix deps.get",
            "sbt": "sbt compile",
            "swift-pm": "swift build",
            "cocoapods": "pod install",
            "deno": "deno cache",
            "bun": "bun install",
            "dotnet": "dotnet restore",
            "stack": "stack build",
            "cabal": "cabal build",
            "clojure-deps": "clojure -P",
            "leiningen": "lein deps",
            "cmake": "cmake -B build && cmake --build build",
            "meson": "meson setup build && meson compile -C build",
            "conan": "conan install .",
            "zig": "zig build",
            "nimble": "nimble install",
            "dune": "opam install . --deps-only && dune build",
            "shards": "shards install",
            "dub": "dub build",
            "julia-pkg": "julia -e 'using Pkg; Pkg.instantiate()'",
            "r-pkg": "Rscript -e 'renv::restore()'",
            "renv": "Rscript -e 'renv::restore()'",
            "cpan": "cpanm --installdeps .",
            "luarocks": "luarocks install",
            "fpm": "fpm build",
            "rebar": "rebar3 compile",
            "hardhat": "npm install",
            "foundry": "forge install",
            "scarb": "scarb build",
            "bazel": "bazel build //...",
            "nix": "nix build",
            "terraform": "terraform init",
            "pulumi": "pulumi up",
            "buf": "buf build",
        }
        ctx.install_command = install_cmds.get(ctx.manifest_type, "")

    # Detect build/test/run commands for languages without parsed manifests
    _LANG_DEFAULTS = {
        "C#": {"build": "dotnet build", "test": "dotnet test", "run": "dotnet run"},
        "F#": {"build": "dotnet build", "test": "dotnet test", "run": "dotnet run"},
        "Visual Basic": {"build": "dotnet build", "test": "dotnet test", "run": "dotnet run"},
        "Haskell": {"build": "stack build", "test": "stack test", "run": "stack run"},
        "Clojure": {"build": "clojure -M:build", "test": "clojure -M:test", "run": "clojure -M -m main"},
        "Erlang": {"build": "rebar3 compile", "test": "rebar3 eunit", "run": "rebar3 shell"},
        "Zig": {"build": "zig build", "test": "zig build test", "run": "zig build run"},
        "Nim": {"build": "nim compile", "test": "nimble test", "run": "nimble run"},
        "OCaml": {"build": "dune build", "test": "dune test", "run": "dune exec"},
        "Crystal": {"build": "shards build", "test": "crystal spec", "run": "crystal run"},
        "D": {"build": "dub build", "test": "dub test", "run": "dub run"},
        "Julia": {"build": "", "test": "julia -e 'using Pkg; Pkg.test()'", "run": "julia src/main.jl"},
        "R": {"build": "R CMD build .", "test": "Rscript -e 'testthat::test_local()'", "run": "Rscript main.R"},
        "Perl": {"build": "perl Makefile.PL && make", "test": "prove -l t", "run": "perl main.pl"},
        "Lua": {"build": "", "test": "busted", "run": "lua main.lua"},
        "Fortran": {"build": "fpm build", "test": "fpm test", "run": "fpm run"},
        "Solidity": {"build": "npx hardhat compile", "test": "npx hardhat test", "run": ""},
        "HCL": {"build": "terraform plan", "test": "terraform validate", "run": "terraform apply"},
        "Nix": {"build": "nix build", "test": "nix flake check", "run": "nix run"},
        "V": {"build": "v .", "test": "v test .", "run": "v run ."},
        "Cairo": {"build": "scarb build", "test": "scarb test", "run": ""},
        "Move": {"build": "aptos move compile", "test": "aptos move test", "run": ""},
        "Protobuf": {"build": "buf build", "test": "buf lint", "run": ""},
    }
    for lang in ctx.languages:
        defaults = _LANG_DEFAULTS.get(lang, {})
        if defaults:
            ctx.build_command = ctx.build_command or defaults.get("build", "")
            ctx.test_command = ctx.test_command or defaults.get("test", "")
            ctx.run_command = ctx.run_command or defaults.get("run", "")

    # Detect frameworks from dependencies
    dep_names_lower = {d.lower() for d in ctx.key_dependencies}
    for framework, signals in _FRAMEWORK_SIGNALS.items():
        if any(s in dep_names_lower for s in signals):
            if framework not in ctx.frameworks:
                ctx.frameworks.append(framework)


def _parse_package_json(path: Path, ctx: ProjectContext):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return

    ctx.project_name = ctx.project_name or data.get("name", "")
    ctx.description = ctx.description or data.get("description", "")

    # Scripts → commands
    scripts = data.get("scripts", {})
    if "build" in scripts:
        ctx.build_command = ctx.build_command or f"npm run build"
    if "test" in scripts:
        ctx.test_command = ctx.test_command or f"npm test"
    if "lint" in scripts:
        ctx.lint_command = ctx.lint_command or f"npm run lint"
    if "dev" in scripts:
        ctx.run_command = ctx.run_command or f"npm run dev"
    elif "start" in scripts:
        ctx.run_command = ctx.run_command or f"npm start"

    ctx.install_command = ctx.install_command or "npm install"

    # Collect key dependencies
    deps = list(data.get("dependencies", {}).keys())
    dev_deps = list(data.get("devDependencies", {}).keys())
    ctx.key_dependencies = deps[:20] + dev_deps[:10]

    # Detect TypeScript
    if "typescript" in dev_deps or "typescript" in deps:
        if "JavaScript" in ctx.languages:
            ctx.languages.remove("JavaScript")
        if "TypeScript" not in ctx.languages:
            ctx.languages.append("TypeScript")

    # Entry point
    ctx.entry_point = ctx.entry_point or data.get("main", "")


def _parse_pyproject_toml(path: Path, ctx: ProjectContext):
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return

    # Simple TOML parsing without a library — extract key fields
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("name") and "=" in line:
            ctx.project_name = ctx.project_name or _extract_toml_string(line)
        elif line.startswith("description") and "=" in line:
            ctx.description = ctx.description or _extract_toml_string(line)

    # Extract dependencies
    in_deps = False
    for line in content.splitlines():
        stripped = line.strip()
        if stripped in ("[project.dependencies]", "[tool.poetry.dependencies]"):
            in_deps = True
            continue
        if in_deps:
            if stripped.startswith("["):
                in_deps = False
                continue
            if "=" in stripped or stripped.startswith('"'):
                dep_name = stripped.split("=")[0].strip().strip('"').strip("'")
                if dep_name and dep_name != "python":
                    ctx.key_dependencies.append(dep_name)

    # Scripts
    in_scripts = False
    for line in content.splitlines():
        stripped = line.strip()
        if stripped == "[project.scripts]" or stripped == "[tool.poetry.scripts]":
            in_scripts = True
            continue
        if in_scripts:
            if stripped.startswith("["):
                break
            if "=" in stripped:
                script_name = stripped.split("=")[0].strip()
                if not ctx.entry_point:
                    ctx.entry_point = script_name


def _parse_requirements_txt(path: Path, ctx: ProjectContext):
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        # Extract package name (before ==, >=, etc.)
        dep_name = line.split("==")[0].split(">=")[0].split("<=")[0].split("~=")[0].split("[")[0].strip()
        if dep_name:
            ctx.key_dependencies.append(dep_name)

    # Common Python commands
    if not ctx.run_command:
        if "uvicorn" in ctx.key_dependencies or "fastapi" in ctx.key_dependencies:
            ctx.run_command = "uvicorn app:app --reload"
        elif "flask" in [d.lower() for d in ctx.key_dependencies]:
            ctx.run_command = "flask run"
        elif "django" in [d.lower() for d in ctx.key_dependencies]:
            ctx.run_command = "python manage.py runserver"

    if not ctx.test_command:
        if "pytest" in [d.lower() for d in ctx.key_dependencies]:
            ctx.test_command = "pytest"


def _parse_cargo_toml(path: Path, ctx: ProjectContext):
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return

    for line in content.splitlines():
        line = line.strip()
        if line.startswith("name") and "=" in line:
            ctx.project_name = ctx.project_name or _extract_toml_string(line)
        elif line.startswith("description") and "=" in line:
            ctx.description = ctx.description or _extract_toml_string(line)

    ctx.build_command = ctx.build_command or "cargo build"
    ctx.test_command = ctx.test_command or "cargo test"
    ctx.run_command = ctx.run_command or "cargo run"
    ctx.install_command = ctx.install_command or "cargo build"

    # Extract dependencies
    in_deps = False
    for line in content.splitlines():
        stripped = line.strip()
        if stripped == "[dependencies]":
            in_deps = True
            continue
        if in_deps:
            if stripped.startswith("["):
                in_deps = False
                continue
            if "=" in stripped:
                dep_name = stripped.split("=")[0].strip()
                if dep_name:
                    ctx.key_dependencies.append(dep_name)


def _parse_go_mod(path: Path, ctx: ProjectContext):
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return

    for line in content.splitlines():
        line = line.strip()
        if line.startswith("module "):
            module_name = line[7:].strip()
            ctx.project_name = ctx.project_name or module_name.split("/")[-1]

    ctx.build_command = ctx.build_command or "go build ./..."
    ctx.test_command = ctx.test_command or "go test ./..."
    ctx.run_command = ctx.run_command or "go run ."
    ctx.install_command = ctx.install_command or "go mod download"

    # Extract deps from require block
    in_require = False
    for line in content.splitlines():
        stripped = line.strip()
        if stripped == "require (":
            in_require = True
            continue
        if in_require:
            if stripped == ")":
                in_require = False
                continue
            parts = stripped.split()
            if parts:
                dep_path = parts[0]
                dep_name = dep_path.split("/")[-1]
                ctx.key_dependencies.append(dep_name)

    # Detect Go frameworks from dependencies
    dep_str = " ".join(ctx.key_dependencies).lower()
    go_frameworks = {
        "Gin": "gin",
        "Echo": "echo",
        "Fiber": "fiber",
        "Chi": "chi",
        "Gorilla Mux": "mux",
        "GORM": "gorm",
    }
    for fw, signal in go_frameworks.items():
        if signal in dep_str and fw not in ctx.frameworks:
            ctx.frameworks.append(fw)


def _parse_gemfile(path: Path, ctx: ProjectContext):
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return

    for line in content.splitlines():
        line = line.strip()
        if line.startswith("gem "):
            parts = line.split("'")
            if len(parts) >= 2:
                ctx.key_dependencies.append(parts[1])
            else:
                parts = line.split('"')
                if len(parts) >= 2:
                    ctx.key_dependencies.append(parts[1])

    ctx.test_command = ctx.test_command or "bundle exec rspec"
    ctx.run_command = ctx.run_command or "bundle exec rails server"
    ctx.install_command = ctx.install_command or "bundle install"


def _parse_composer_json(path: Path, ctx: ProjectContext):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return

    ctx.project_name = ctx.project_name or data.get("name", "").split("/")[-1]
    ctx.description = ctx.description or data.get("description", "")

    deps = list(data.get("require", {}).keys())
    ctx.key_dependencies = deps[:20]

    scripts = data.get("scripts", {})
    if "test" in scripts:
        ctx.test_command = ctx.test_command or "composer test"

    ctx.install_command = ctx.install_command or "composer install"


def _parse_pubspec_yaml(path: Path, ctx: ProjectContext):
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return

    for line in content.splitlines():
        line = line.strip()
        if line.startswith("name:"):
            ctx.project_name = ctx.project_name or line.split(":", 1)[1].strip()
        elif line.startswith("description:"):
            ctx.description = ctx.description or line.split(":", 1)[1].strip().strip('"').strip("'")

    # Detect Flutter
    if "flutter" in content.lower():
        if "Flutter" not in ctx.frameworks:
            ctx.frameworks.append("Flutter")
        ctx.run_command = ctx.run_command or "flutter run"
        ctx.test_command = ctx.test_command or "flutter test"
        ctx.build_command = ctx.build_command or "flutter build"
    else:
        ctx.run_command = ctx.run_command or "dart run"
        ctx.test_command = ctx.test_command or "dart test"

    ctx.install_command = ctx.install_command or "dart pub get"


def _extract_toml_string(line: str) -> str:
    """Extract a string value from a TOML key = 'value' line."""
    if "=" not in line:
        return ""
    value = line.split("=", 1)[1].strip()
    return value.strip('"').strip("'")


# ── Phase 2: Directory Role Detection ──────────────────────────

_DIRECTORY_ROLES: Dict[str, str] = {
    # Source code
    "src": "source code",
    "lib": "library code",
    "app": "application code",
    "pkg": "packages",
    "internal": "internal packages (Go)",
    "cmd": "command entry points (Go)",
    # API layer
    "routes": "API routes",
    "router": "API router",
    "controllers": "request handlers",
    "handlers": "request handlers",
    "api": "API layer",
    "endpoints": "API endpoints",
    "views": "views / request handlers",
    # Data layer
    "models": "data models",
    "entities": "domain entities",
    "schemas": "data schemas",
    "types": "type definitions",
    # Business logic
    "services": "business logic / services",
    "usecases": "use cases / business logic",
    "domain": "domain logic",
    "core": "core business logic",
    # Infrastructure
    "config": "configuration",
    "conf": "configuration",
    "settings": "settings",
    "migrations": "database migrations",
    "db": "database",
    "database": "database",
    # UI
    "components": "UI components",
    "pages": "page components / routes",
    "templates": "template files",
    "layouts": "layout templates",
    "widgets": "UI widgets",
    "features": "feature modules",
    # Assets
    "static": "static assets",
    "public": "public assets",
    "assets": "media / asset files",
    "styles": "stylesheets",
    "css": "stylesheets",
    # Testing
    "test": "tests",
    "tests": "tests",
    "__tests__": "tests",
    "spec": "test specs",
    "specs": "test specs",
    "e2e": "end-to-end tests",
    "integration": "integration tests",
    # Support
    "utils": "utility functions",
    "helpers": "helper functions",
    "common": "shared / common code",
    "shared": "shared code",
    "middleware": "middleware",
    "plugins": "plugins / extensions",
    "hooks": "hooks (React / lifecycle)",
    "store": "state management",
    "stores": "state management",
    "state": "state management",
    "reducers": "Redux reducers",
    "actions": "Redux actions",
    "context": "context / providers",
    # Documentation
    "docs": "documentation",
    "doc": "documentation",
    # Build / deploy
    "scripts": "build / utility scripts",
    "bin": "executable scripts",
    "deploy": "deployment configuration",
    "infra": "infrastructure as code",
    "terraform": "Terraform IaC",
    "k8s": "Kubernetes manifests",
    "helm": "Helm charts",
    ".github": "GitHub Actions / config",
    ".circleci": "CircleCI config",
    # Memory / AI (project-specific patterns)
    "agents": "AI agents",
    "tools": "tool implementations",
    "prompts": "prompt templates",
    "memory": "memory / state management",
    "llm": "LLM provider integration",
    "chains": "LLM chains / pipelines",
}


def _detect_directory_roles(root: Path, ctx: ProjectContext):
    """Map top-level directories to their architectural roles."""
    try:
        entries = list(root.iterdir())
    except OSError:
        return

    for entry in entries:
        if not entry.is_dir():
            continue
        name = entry.name
        if name.startswith(".") and name not in (".github", ".circleci"):
            continue
        role = _DIRECTORY_ROLES.get(name)
        if role:
            ctx.directory_roles[name] = role


# ── Phase 3: High-Signal Files ─────────────────────────────────

_AI_INSTRUCTION_FILES = [
    "CLAUDE.md",
    ".cursorrules",
    ".cursor/rules/project.mdc",
    ".github/copilot-instructions.md",
    ".ai/instructions.md",
    "AGENTS.md",
]


def _read_high_signal_files(root: Path, ctx: ProjectContext):
    """Read README, AI instructions, Makefile for project context."""

    # README
    for readme_name in ("README.md", "README.rst", "README.txt", "README"):
        readme_path = root / readme_name
        if readme_path.exists():
            try:
                content = readme_path.read_text(encoding="utf-8", errors="replace")
                # Extract first paragraph as summary
                lines = content.split("\n")
                summary_lines = []
                found_content = False
                for line in lines:
                    stripped = line.strip()
                    if not stripped:
                        if found_content:
                            break
                        continue
                    if stripped.startswith("#"):
                        found_content = True
                        continue
                    found_content = True
                    summary_lines.append(stripped)
                    if len(summary_lines) >= 3:
                        break
                ctx.readme_summary = " ".join(summary_lines)[:300]
            except OSError:
                pass
            break

    # AI instruction files
    for ai_file in _AI_INSTRUCTION_FILES:
        ai_path = root / ai_file
        if ai_path.exists():
            try:
                content = ai_path.read_text(encoding="utf-8", errors="replace")
                ctx.ai_instructions = content[:2000]
            except OSError:
                pass
            break

    # Makefile → commands
    makefile = root / "Makefile"
    if makefile.exists():
        try:
            content = makefile.read_text(encoding="utf-8", errors="replace")
            _extract_makefile_commands(content, ctx)
        except OSError:
            pass

    # Dockerfile → runtime
    for docker_name in ("Dockerfile", "docker-compose.yml", "docker-compose.yaml"):
        if (root / docker_name).exists():
            if not ctx.runtime:
                ctx.runtime = "Docker"
            break


def _extract_makefile_commands(content: str, ctx: ProjectContext):
    """Extract build/test/lint targets from a Makefile."""
    targets = set()
    for line in content.splitlines():
        if line and not line.startswith("\t") and not line.startswith(" ") and ":" in line:
            target = line.split(":")[0].strip()
            if target and not target.startswith(".") and not target.startswith("#"):
                targets.add(target)

    if "build" in targets and not ctx.build_command:
        ctx.build_command = "make build"
    if "test" in targets and not ctx.test_command:
        ctx.test_command = "make test"
    if "lint" in targets and not ctx.lint_command:
        ctx.lint_command = "make lint"
    if "run" in targets and not ctx.run_command:
        ctx.run_command = "make run"
    if "dev" in targets and not ctx.run_command:
        ctx.run_command = "make dev"


# ── Phase 4: Entry Point Detection ─────────────────────────────

_ENTRY_POINT_PATTERNS = [
    # Python
    ("main.py", "python main.py"),
    ("app.py", "python app.py"),
    ("manage.py", "python manage.py"),
    ("wsgi.py", ""),
    ("asgi.py", ""),
    # JavaScript
    ("index.js", "node index.js"),
    ("server.js", "node server.js"),
    ("app.js", "node app.js"),
    ("index.ts", ""),
    ("server.ts", ""),
    # Go
    ("main.go", "go run main.go"),
    # Rust
    ("src/main.rs", "cargo run"),
    ("src/lib.rs", ""),
    # Java
    ("src/main/java", ""),
    # Ruby
    ("config.ru", "rackup"),
]


def _detect_entry_point(root: Path, ctx: ProjectContext):
    """Find the project's main entry point file."""
    if ctx.entry_point:
        return

    for entry_file, run_cmd in _ENTRY_POINT_PATTERNS:
        if (root / entry_file).exists():
            ctx.entry_point = entry_file
            if run_cmd and not ctx.run_command:
                ctx.run_command = run_cmd
            break
