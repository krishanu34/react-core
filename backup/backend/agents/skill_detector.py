"""
Skill Detector — Picks the right skill .md files based on the user message
and optional project context string.

Claude Code approach: the base system prompt stays fixed for every request.
Domain expertise is injected on top by loading the matching skill file(s).

Examples:
  "fix the React hook bug"          → [react_frontend, bug_fixing]
  "add JWT auth to my FastAPI app"  → [python_backend, security]
  "write unit tests for the cart"   → [testing]
  "deploy with Docker + GitHub CI"  → [devops]
  "design the database schema"      → [database]
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class SkillMatch:
    """Result returned by detect_skills()."""
    skills: list[str]       # skill file names (no .md), highest confidence first
    confidence: str         # "high" | "medium" | "low" | "none"
    reasons: list[str]      # human-readable match reasons (sent as SSE event)


# ── Skill registry ────────────────────────────────────────────────────────────
#
# Each entry:
#   priority  — tiebreaker when two skills have the same keyword match count
#   keywords  — matched against the combined user message + project context
#   file_ext  — file extensions that strongly imply this skill (counted as 2 keyword hits)

_SKILLS: dict[str, dict] = {

    # ── Methodology ───────────────────────────────────────────────────────────

    "bmad_method": {
        "priority": 11,
        "keywords": [
            "bmad", "bmad-method", "bmad method", ".bmad-core", "_bmad",
            "expansion pack", "agent team", "story file", "prd",
            "greenfield workflow", "brownfield workflow", "shard",
            "elicitation", "create-doc", "agent persona", "core-config",
        ],
        "file_ext": [],
    },

    # ── Frontend ──────────────────────────────────────────────────────────────

    "nextjs": {
        "priority": 10,
        "keywords": [
            "next.js", "nextjs", "next js", "app router", "pages router",
            "server component", "client component", "getserversideprops",
            "getstaticprops", "generatestaticparams", "server action",
            "use server", "use client", "layout.tsx", "page.tsx",
            "route handler", "middleware.ts", "next/image", "next/link",
        ],
        "file_ext": [],
    },

    "react_frontend": {
        "priority": 9,
        "keywords": [
            "react", "jsx", "usestate", "useeffect", "useref", "usememo",
            "usecallback", "usecontext", "usereducer", "custom hook",
            "component", "props", "redux", "zustand", "vite react",
            "create react app", "react router", "react query",
            "tanstack query", "recoil", "jotai", "react dom",
        ],
        "file_ext": [".jsx", ".tsx"],
    },

    "vue_frontend": {
        "priority": 9,
        "keywords": [
            "vue", "vuex", "pinia", "nuxt", "composition api", "options api",
            "v-model", "v-for", "v-if", "v-bind", "definecomponent",
            "defineprops", "defineemits", "onmounted", "watcheffect",
        ],
        "file_ext": [".vue"],
    },

    "angular_frontend": {
        "priority": 9,
        "keywords": [
            "angular", "ngmodule", "ngcomponent", "nginjectable",
            "rxjs", "observable", "subject", "behaviorsubject",
            "switchmap", "mergemap", "combinelatest",
            "@component", "@injectable", "@input", "@output", "@ngmodule",
            "angular cli", "ng serve", "ng build", "ng generate",
        ],
        "file_ext": [".component.ts", ".service.ts", ".module.ts"],
    },

    # ── Backend ───────────────────────────────────────────────────────────────

    "python_backend": {
        "priority": 8,
        "keywords": [
            "python", "fastapi", "django", "flask", "pydantic", "sqlalchemy",
            "alembic", "uvicorn", "starlette", "celery", "aiohttp",
            "asyncio", "async def", "requirements.txt", "pyproject.toml",
            "pip install", "venv", "virtualenv", "poetry",
        ],
        "file_ext": [".py"],
    },

    "nodejs_backend": {
        "priority": 8,
        "keywords": [
            "node", "express", "nodejs", "node.js", "koa", "hapi",
            "nestjs", "nest.js", "fastify", "middleware",
            "npm install", "yarn add", "pnpm add", "bun add",
            "require(", "module.exports", "commonjs", "esmodule",
        ],
        "file_ext": [".mjs", ".cjs"],
    },

    # ── Data ──────────────────────────────────────────────────────────────────

    "database": {
        "priority": 7,
        "keywords": [
            "sql", "database", "migration", "schema", "table column",
            "postgres", "postgresql", "mysql", "sqlite", "mongodb",
            "nosql", "orm", "prisma", "typeorm", "sequelize", "drizzle",
            "supabase", "index", "foreign key", "join", "transaction",
            "n+1 problem", "query optimization", "aggregate",
        ],
        "file_ext": [".sql"],
    },

    "data_science": {
        "priority": 7,
        "keywords": [
            "pandas", "numpy", "matplotlib", "seaborn", "plotly",
            "scikit", "sklearn", "machine learning", "deep learning",
            "neural network", "tensorflow", "pytorch", "keras",
            "jupyter", "notebook", "dataframe", "data analysis",
            "feature engineering", "model training", "classification",
            "regression", "clustering", "preprocessing",
        ],
        "file_ext": [".ipynb"],
    },

    # ── Infrastructure ────────────────────────────────────────────────────────

    "api_design": {
        "priority": 6,
        "keywords": [
            "api design", "rest api", "restful", "graphql", "api endpoint",
            "swagger", "openapi", "webhook", "grpc", "json:api",
            "status code", "http method", "pagination", "rate limit",
            "api versioning", "api contract", "api gateway",
        ],
        "file_ext": [],
    },

    # Where dependencies and toolchains live, per ecosystem. High priority
    # because it applies BEFORE the first install command in any language —
    # getting it wrong is only visible much later, when the build works for
    # one person and nobody else. Deliberately NOT a hardcoded rule in the
    # terminal tool: the isolation mechanism differs completely across
    # ecosystems (venv vs node_modules vs Maven's local repo vs bundler's
    # path vs a Gradle wrapper), so the model reasons from the evidence
    # project_context reports instead of one language's rule being applied to
    # all of them.
    "project_environment": {
        "priority": 9,
        "keywords": [
            "install", "installing", "dependency", "dependencies", "package",
            "packages", "requirements", "virtual environment", "virtualenv",
            "venv", "node_modules", "npm install", "pip install", "poetry",
            "pipenv", "conda", "uv", "bundler", "gem install", "composer",
            "maven", "gradle", "nuget", "cargo", "go mod", "go get",
            "lockfile", "lock file", "setup the project", "set up the project",
            "scaffold", "bootstrap", "toolchain", "sdk version",
            "module not found", "modulenotfounderror", "command not found",
            "cannot find module", "package not found", "no module named",
        ],
        "file_ext": [
            "requirements.txt", "pyproject.toml", "package.json", "pom.xml",
            "build.gradle", "gemfile", "composer.json", "go.mod", "cargo.toml",
        ],
    },

    "devops": {
        "priority": 6,
        "keywords": [
            "docker", "dockerfile", "docker-compose", "kubernetes", "k8s",
            "github actions", "gitlab ci", "ci/cd", "pipeline", "deploy",
            "nginx", "terraform", "ansible", "helm", "container", "pod",
            "cluster", "serverless", "lambda", "environment variable",
            "github workflow", "secrets management",
        ],
        "file_ext": ["dockerfile"],
    },

    # ── Language specifics ────────────────────────────────────────────────────

    "typescript": {
        "priority": 5,
        "keywords": [
            "typescript", "tsconfig", "type alias", "interface ",
            "generic type", "utility type", "partial<", "required<",
            "pick<", "omit<", "record<", "readonly", "as const",
            "satisfies ", "infer ", "declaration file", "strict mode",
            "type guard", "discriminated union", "mapped type",
        ],
        "file_ext": [".d.ts"],
    },

    "mobile": {
        "priority": 5,
        "keywords": [
            "react native", "flutter", "dart", "ios", "android",
            "expo", "mobile app", "native module", "react navigation",
            "flatlist", "scrollview", "stylesheet.create", "platform.os",
            "asyncstorage", "xcode", "android studio", "app store",
        ],
        "file_ext": [".dart"],
    },

    # ── Quality & practices ───────────────────────────────────────────────────

    "testing": {
        "priority": 4,
        "keywords": [
            "unit test", "integration test", "e2e test", "end to end",
            "jest", "pytest", "vitest", "cypress", "playwright",
            "mock", "stub", "spy", "fixture", "test coverage",
            "tdd", "bdd", "describe(", "it(", "expect(", "assert",
            "beforeeach", "aftereach", "test suite",
        ],
        "file_ext": [".test.ts", ".test.js", ".spec.ts", ".spec.py"],
    },

    "code_review": {
        "priority": 3,
        "keywords": [
            "code review", "refactor", "clean up", "improve this",
            "optimize", "code smell", "solid principle", "dry principle",
            "single responsibility", "naming convention", "readability",
            "maintainability", "complexity", "technical debt",
        ],
        "file_ext": [],
    },

    "bug_fixing": {
        "priority": 3,
        "keywords": [
            "bug", "fix this", "not working", "broken", "traceback",
            "exception", "crash", "fails", "failing", "debug",
            "why is", "doesn't work", "throws error", "undefined",
            "null pointer", "attributeerror", "typeerror", "syntaxerror",
            "importerror", "keyerror", "indexerror",
        ],
        "file_ext": [],
    },

    "security": {
        "priority": 4,
        "keywords": [
            "security", "authentication", "authorization",
            "jwt", "oauth", "oauth2", "session token", "cookie",
            "xss", "csrf", "sql injection", "injection attack",
            "vulnerability", "encrypt", "hash", "bcrypt",
            "permission", "rbac", "acl", "sanitize input",
            "cors policy", "ssl", "tls", "https",
        ],
        "file_ext": [],
    },
}

# Cap how many skills we inject per request — more than 2 risks bloating the
# context with conflicting domain advice.
MAX_SKILLS = 2


def detect_skills(message: str, project_context: str = "") -> SkillMatch:
    """
    Analyse the user message (+ optional project context) and return the
    most relevant skills to inject into the system prompt.

    Returns at most MAX_SKILLS skills ranked by (match_count, priority).
    Returns SkillMatch(skills=[], confidence="none", ...) when no specific
    domain is detected — the base prompt is sufficient for general tasks.
    """
    combined = (message + " " + project_context).lower()

    scores: dict[str, tuple[int, int, list[str]]] = {}

    for skill_name, cfg in _SKILLS.items():
        matched: list[str] = []
        weight = 0

        # Keyword matching
        for kw in cfg["keywords"]:
            kw_lower = kw.lower()
            # Short keywords need word-boundary check to avoid false positives
            if len(kw_lower) <= 3:
                if re.search(r'\b' + re.escape(kw_lower) + r'\b', combined):
                    matched.append(kw)
                    weight += 1
            elif kw_lower in combined:
                matched.append(kw)
                weight += 1

        # File extension hits count double (very strong signal)
        for ext in cfg.get("file_ext", []):
            if ext.lower() in combined:
                matched.append(f"file:{ext}")
                weight += 2

        if matched:
            scores[skill_name] = (weight, cfg["priority"], matched)

    if not scores:
        return SkillMatch(
            skills=[],
            confidence="none",
            reasons=["No domain detected — base prompt is sufficient"],
        )

    # Rank: highest weight first, priority as tiebreaker
    ranked = sorted(scores.items(), key=lambda x: (x[1][0], x[1][1]), reverse=True)
    selected = ranked[:MAX_SKILLS]

    skills  = [name for name, _ in selected]
    reasons = [
        f"'{name}': {data[0]} signal(s) — {', '.join(data[2][:4])}"
        for name, data in selected
    ]

    top_weight = selected[0][1][0]
    confidence = "high" if top_weight >= 4 else "medium" if top_weight >= 2 else "low"

    return SkillMatch(skills=skills, confidence=confidence, reasons=reasons)
