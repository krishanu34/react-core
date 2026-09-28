"""
Sensitive-operation classifier — WHAT a tool call actually does, not which
tool it is.

Gating on tool NAMES alone is too coarse in both directions. `file_write` to
`README.md` and `file_write` to `.env` are the same tool and wildly different
decisions; `run_terminal` running `pytest` and `run_terminal` running
`alembic upgrade head` likewise. A human approving a change needs to be told
which one they are looking at — an approval card that says "run_terminal" and
nothing else trains people to click Approve without reading.

So this module answers a different question: given a tool name and the
arguments the model produced, does this call touch a class of thing that a
human would want to be told about? It returns a CATEGORY and a plain-English
reason, which the permission layer uses two ways:

  1. To force an approval prompt for a call that the tool-name rules would
     have let through — including on tools that do not exist yet.
  2. To label the approval card, so the human is consenting to "writes
     credentials / secrets" rather than to "file_write".

DESIGN RULES (these are why it is not a list of special cases):

  • Categories, not instances. Every rule belongs to a named risk class, and
    a new pattern is added to an existing class rather than bolted on. The
    classes are what the UI shows and what tests assert against.

  • Arguments are harvested GENERICALLY. `classify()` does not know the
    parameter schema of any specific tool. It pulls command-shaped and
    path-shaped values out of an arbitrary dict (including nested lists), so
    a tool added next month is covered without touching this file.

  • Templates are not secrets. `.env.example` and `application.properties.tmpl`
    exist to be committed and edited freely; flagging them would produce
    prompts that teach users to stop reading prompts.

  • Read-only forms are excluded where they are cheap to distinguish
    (`git status` vs `git push`, `terraform plan` vs `terraform apply`), for
    the same reason.

This is advisory classification, NOT a security boundary. It runs on strings
a model produced, and a determined bypass is always possible (base64, an
indirection through a script file). The real boundaries are elsewhere:
secret redaction in tools/sensitive_guard.py, secret-stripped subprocess
environments in run_terminal_tool.py, the destructive-command gate in that
same tool, and the workspace root sandbox. This layer exists to make consent
INFORMED, not to make it unnecessary.
"""

import re
from dataclasses import dataclass
from typing import Iterator, List, Optional, Tuple


@dataclass(frozen=True)
class SensitiveOp:
    """A classified high-impact operation."""
    category: str   # stable id — the UI and tests key off this
    reason: str     # plain-English, shown on the approval card
    evidence: str = ""   # the substring that triggered it (truncated)

    def describe(self) -> str:
        return self.reason


# ── Categories ───────────────────────────────────────────────────────────────
# Ordered by how much a human cares. classify() returns the FIRST match in
# this order, so a command that both installs a package and touches a
# database reports the database.

CATEGORY_SECRETS = "secrets"
CATEGORY_DATABASE = "database"
CATEGORY_INFRASTRUCTURE = "infrastructure"
CATEGORY_VCS_PUBLISH = "vcs_publish"
CATEGORY_DEPENDENCIES = "dependencies"
CATEGORY_SERVICES = "services"

# Human-readable, per category. Kept here (not inline) so the same wording
# reaches the approval card, the audit log and the tests.
_CATEGORY_REASON = {
    CATEGORY_SECRETS: "reads or modifies credentials / secret configuration",
    CATEGORY_DATABASE: "changes database schema or data",
    CATEGORY_INFRASTRUCTURE: "changes deployment or infrastructure configuration",
    CATEGORY_VCS_PUBLISH: "publishes or rewrites version-control history",
    CATEGORY_DEPENDENCIES: "installs or changes project dependencies",
    CATEGORY_SERVICES: "starts, stops or reconfigures a running service",
}


# ── Path rules ───────────────────────────────────────────────────────────────
# Matched against the POSIX-normalised, lower-cased path. Anchored on the
# basename where the filename is the signal, on a path segment where the
# DIRECTORY is the signal (migrations/, .github/workflows/).

# Template/sample files are deliberately exempt: they exist to be committed
# and edited, and prompting on them is pure noise. Checked before everything.
_TEMPLATE_SUFFIXES = (
    ".example", ".sample", ".template", ".tmpl", ".dist", ".defaults", ".ci",
)

_PATH_RULES: List[Tuple[str, re.Pattern]] = [
    (CATEGORY_SECRETS, re.compile(
        r"(^|/)("
        r"\.env(\.[^/]*)?"                      # .env, .env.local, .env.production
        r"|.*credentials?[^/]*"                 # credentials.json, aws_credentials
        r"|.*secrets?[^/]*\.(ya?ml|json|toml|ini|properties)"
        r"|id_rsa[^/]*|id_ed25519[^/]*"         # private SSH keys
        r"|.*\.(pem|key|p12|pfx|jks|keystore|asc|ppk)"
        r"|appsettings([.-][^/]*)?\.json"       # .NET config carries connection strings
        r"|application([.-][^/]*)?\.(properties|ya?ml)"   # Spring
        r"|\.npmrc|\.pypirc|\.netrc|\.htpasswd"
        r"|.*\.pubxml|.*\.publishsettings"
        r")$")),

    (CATEGORY_DATABASE, re.compile(
        r"(^|/)(migrations?|alembic|db/migrate|prisma)(/|$)"
        r"|(^|/)[^/]*\.sql$"
        r"|(^|/)schema\.prisma$"
        r"|(^|/)(knexfile|ormconfig|liquibase\.properties|flyway\.conf)[^/]*$")),

    (CATEGORY_INFRASTRUCTURE, re.compile(
        r"(^|/)\.github/workflows/"
        r"|(^|/)(\.gitlab-ci\.ya?ml|azure-pipelines([.-][^/]*)?\.ya?ml|jenkinsfile"
        r"|bitbucket-pipelines\.ya?ml|\.circleci/config\.ya?ml)$"
        r"|(^|/)dockerfile[^/]*$"
        r"|(^|/)(docker-)?compose([.-][^/]*)?\.ya?ml$"
        r"|(^|/)[^/]*\.tf(vars)?$"
        r"|(^|/)(serverless|vercel|netlify|fly|render|app|nginx|procfile)"
        r"(\.(ya?ml|json|toml|conf))?$"
        r"|(^|/)(helm|charts|k8s|kubernetes|manifests|deploy(ment)?s?)/"
        r"|(^|/)(values|ingress|deployment|service|configmap)\.ya?ml$")),

    (CATEGORY_DEPENDENCIES, re.compile(
        r"(^|/)("
        r"requirements([.-][^/]*)?\.txt|pyproject\.toml|pipfile(\.lock)?|poetry\.lock"
        r"|package(-lock)?\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?"
        r"|cargo\.(toml|lock)|go\.(mod|sum)|pom\.xml|build\.gradle(\.kts)?"
        r"|gemfile(\.lock)?|composer\.(json|lock)|.*\.csproj|packages\.config"
        r")$")),
]


def classify_path(path: str) -> Optional[SensitiveOp]:
    """Classify a filesystem path. Returns None for ordinary source files."""
    if not path or not isinstance(path, str):
        return None
    norm = path.replace("\\", "/").strip().lower().rstrip("/")
    if not norm:
        return None

    base = norm.rsplit("/", 1)[-1]
    # A template of a sensitive file is not sensitive. Checked on the basename
    # so "config/.env.example" and ".env.example" behave the same.
    if base.endswith(_TEMPLATE_SUFFIXES) or ".example." in base or ".sample." in base:
        return None

    for category, pattern in _PATH_RULES:
        m = pattern.search(norm)
        if m:
            return SensitiveOp(category, _CATEGORY_REASON[category], _trim(path))
    return None


# ── Command rules ────────────────────────────────────────────────────────────
# Each entry is (category, pattern). Patterns are matched case-insensitively
# against the whole command line, including anything after `&&`, `;` or `|` —
# a chained command is still that command.

_COMMAND_RULES: List[Tuple[str, re.Pattern]] = [
    (CATEGORY_SECRETS, re.compile(
        r"\b(openssl\s+(genrsa|req|pkcs12)|ssh-keygen|keytool)\b"
        r"|\b(setx|export|set)\s+\w*(API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)"
        r"|\b(az\s+keyvault|aws\s+secretsmanager|gcloud\s+secrets|vault\s+(write|kv))\b",
        re.I)),

    (CATEGORY_DATABASE, re.compile(
        # Migration frameworks — the common way schema changes actually happen.
        r"\b(alembic|flyway|liquibase|sqitch|dbmate|goose|atlas)\b"
        r"|\bprisma\s+(migrate|db\s+(push|execute|seed))\b"
        r"|\b(rails|rake)\s+db:"
        r"|\bpython\s+manage\.py\s+(migrate|makemigrations|flush|loaddata|sqlflush)\b"
        r"|\b(php\s+)?artisan\s+(migrate|db:)"
        r"|\b(typeorm|sequelize|knex|drizzle-kit|django-admin)\b.*\b(migrat|seed|push|sync)"
        r"|\b(npm|pnpm|yarn|bun)\s+run\s+[\w:-]*(migrat|seed|db[:-])"
        # Direct clients.
        r"|\b(psql|mysql|mysqladmin|mongo|mongosh|mongoimport|sqlcmd|sqlite3|redis-cli|cqlsh)\b"
        # Raw SQL anywhere in the line (DDL + write DML). SELECT is not here.
        r"|\b(insert\s+into|update\s+\S+\s+set|delete\s+from|merge\s+into"
        r"|create\s+(table|database|schema|index|view|user)"
        r"|alter\s+(table|database|schema|user)|drop\s+(table|database|schema|index|view)"
        r"|truncate\s+table|grant\s+\w+\s+on|revoke\s+\w+\s+on)\b",
        re.I)),

    (CATEGORY_INFRASTRUCTURE, re.compile(
        # `plan`/`validate`/`diff`/`get`/`describe` are reads — excluded.
        r"\bterraform\s+(apply|destroy|import|state\s+(rm|mv|push)|taint)\b"
        r"|\bpulumi\s+(up|destroy|import)\b"
        r"|\bkubectl\s+(apply|create|delete|patch|replace|scale|rollout|edit|set|drain|cordon)\b"
        r"|\bhelm\s+(install|upgrade|uninstall|rollback|delete)\b"
        r"|\bdocker(\s+compose)?\s+(up|down|push|rm|rmi|prune|swarm|stack)\b"
        r"|\b(vercel|netlify|serverless|sls|flyctl|fly|heroku|firebase|amplify|now)\s+"
        r"(deploy|--prod|releases?|apply)\b"
        r"|\bansible-playbook\b|\bchef-client\b|\bpuppet\s+apply\b"
        r"|\b(aws|az|gcloud)\s+\S+\s+(create|delete|update|deploy|put|set|apply|remove)\b"
        r"|\bcdk\s+(deploy|destroy)\b|\bsam\s+deploy\b",
        re.I)),

    (CATEGORY_VCS_PUBLISH, re.compile(
        r"\bgit\s+push\b"
        r"|\bgit\s+reset\s+--hard\b"
        r"|\bgit\s+clean\s+-\S*f"
        r"|\bgit\s+(rebase|filter-branch|filter-repo)\b"
        r"|\bgit\s+(branch|tag)\s+-\S*[Dd]\b"
        r"|\bgit\s+remote\s+(add|set-url|remove)\b"
        r"|\bgh\s+(pr\s+(create|merge)|release\s+create|repo\s+(create|delete))\b",
        re.I)),

    (CATEGORY_DEPENDENCIES, re.compile(
        r"\b(pip3?|uv|poetry|pipenv|conda|mamba)\s+(install|add|remove|uninstall|sync)\b"
        r"|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update|upgrade|ci|link)\b"
        r"|\b(apt|apt-get|yum|dnf|apk|zypper|pacman|brew|choco|winget|scoop|snap)\s+"
        r"(install|add|remove|uninstall|upgrade|update)\b"
        r"|\bcargo\s+(add|install|remove|update)\b"
        r"|\bgo\s+(get|install|mod\s+(tidy|download))\b"
        r"|\bdotnet\s+(add|restore|tool\s+install)\b"
        r"|\bgem\s+(install|uninstall|update)\b"
        r"|\bcomposer\s+(require|install|update|remove)\b"
        r"|\b(mvn|gradle|gradlew)\s+\S*(install|publish)\b",
        re.I)),

    (CATEGORY_SERVICES, re.compile(
        r"\b(systemctl|service)\s+(start|stop|restart|reload|enable|disable|mask)\b"
        r"|\bsc(\.exe)?\s+(start|stop|delete|create|config)\b"
        r"|\bnet\s+(start|stop)\b"
        r"|\bpm2\s+(start|stop|restart|delete|reload)\b"
        r"|\b(iisreset|nssm)\b"
        r"|\b(launchctl)\s+(load|unload|bootstrap|bootout)\b"
        r"|\bcrontab\s+-\S*[re]\b|\bschtasks\s+/(create|delete|change)\b",
        re.I)),
]


def classify_command(command: str) -> Optional[SensitiveOp]:
    """Classify a shell command line. Returns None for ordinary commands
    (tests, builds, linters, reads)."""
    if not command or not isinstance(command, str):
        return None
    for category, pattern in _COMMAND_RULES:
        m = pattern.search(command)
        if m:
            return SensitiveOp(category, _CATEGORY_REASON[category],
                               _trim(m.group(0)))
    return None


# ── Generic argument harvesting ──────────────────────────────────────────────
# The point of doing this by KEY SHAPE rather than by tool schema: a tool
# added later gets classified without anyone remembering to update this file.

_COMMAND_KEYS = {
    "command", "cmd", "commands", "script", "shell", "sql", "statement",
    "args", "argv", "run",
}
_PATH_KEYS = {
    "path", "paths", "file", "files", "file_path", "file_paths", "filename",
    "filepath", "target", "targets", "dest", "destination", "output_path",
    "notebook_path", "source", "src", "directory", "dir", "location",
}


def _walk_values(value, key: str = "") -> Iterator[Tuple[str, str]]:
    """Yield (key, string) for every string in a nested argument structure.
    Depth is naturally bounded by the model's own argument size."""
    if isinstance(value, str):
        yield key, value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from _walk_values(v, str(k).lower())
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _walk_values(v, key)


def classify(tool_name: str, arguments: Optional[dict],
             include_paths: bool = True) -> Optional[SensitiveOp]:
    """
    Classify a tool call. Returns the highest-priority SensitiveOp found in
    the arguments, or None.

    Commands are checked before paths: `run_terminal` with an alembic command
    should report "database", not "dependencies" because the line also
    mentions requirements.txt.

    `include_paths=False` restricts the check to command-shaped arguments.
    Callers use this for tools that only READ: opening `migrations/001.sql`
    or `.env` changes nothing — reading them is how the agent understands the
    project, and their secret values are redacted on the way out — so a path
    alone must not raise a prompt. A command hiding in a read-only tool's
    arguments still does, because that executes.
    """
    if not isinstance(arguments, dict) or not arguments:
        return None

    strings = list(_walk_values(arguments))

    # Pass 1 — anything that is or contains a command line.
    for key, text in strings:
        if key in _COMMAND_KEYS:
            hit = classify_command(text)
            if hit:
                return hit

    if not include_paths:
        return None

    # Pass 2 — explicit path arguments.
    for key, text in strings:
        if key in _PATH_KEYS:
            hit = classify_path(text)
            if hit:
                return hit

    # Pass 3 — catch-all. A path can arrive under a key we did not predict
    # (a new tool's `notebook`, `manifest`, `config_file`). Only values that
    # actually LOOK like a path are considered, so prose in a `content` or
    # `description` field cannot trip the classifier.
    for key, text in strings:
        if key in _COMMAND_KEYS or key in _PATH_KEYS:
            continue
        if _looks_like_path(text):
            hit = classify_path(text)
            if hit:
                return hit
    return None


_PATH_SHAPE = re.compile(r"^[^\s\n\"'<>|]{1,300}$")


def _looks_like_path(text: str) -> bool:
    """A single-line, whitespace-free token with a separator or an extension.
    Deliberately strict: the cost of a false positive here is an approval
    prompt on a file that did not need one."""
    if not text or "\n" in text or len(text) > 300:
        return False
    if not _PATH_SHAPE.match(text):
        return False
    return ("/" in text or "\\" in text or "." in text)


def _trim(text: str, limit: int = 120) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit - 1] + "…"
