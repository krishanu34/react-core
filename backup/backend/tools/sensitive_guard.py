"""
Sensitive Content Redaction Guard

Strips known secret patterns from tool output BEFORE it reaches the LLM
or is streamed to the client. This is a safety net — it runs on the content
of files the agent legitimately reads in the user's workspace.

What this does NOT do:
  - Block reading user workspace files (including .env) — those belong to the user
  - Replace path sandboxing — BaseTool._resolve_path() already prevents
    accessing files outside the workspace (DevSphere's own .env is unreachable)

What this DOES do:
  - Prevent raw secret values from appearing verbatim in LLM context or responses
  - Cover common formats: OpenAI keys, AWS keys, GitHub tokens, generic passwords
"""

import re

# Each entry: (compiled regex, replacement string)
_SECRET_PATTERNS = [
    # OpenAI / Anthropic API keys
    (re.compile(r'sk-[a-zA-Z0-9]{20,}'), "sk-[REDACTED]"),
    # AWS access key IDs
    (re.compile(r'AKIA[A-Z0-9]{16}'), "AKIA[REDACTED]"),
    # AWS secret access keys
    (re.compile(r'(?i)(aws_secret_access_key\s*[=:]\s*)[a-zA-Z0-9+/]{40}'), r'\1[REDACTED]'),
    # GitHub PATs and tokens
    (re.compile(r'gh[pso]_[a-zA-Z0-9]{36}'), "gh*_[REDACTED]"),
    (re.compile(r'github_pat_[a-zA-Z0-9_]{82}'), "github_pat_[REDACTED]"),
    # Slack tokens
    (re.compile(r'xox[bpoa]-[0-9A-Za-z\-]{10,}'), "xox*-[REDACTED]"),
    # Google API keys
    (re.compile(r'AIza[0-9A-Za-z\-_]{35}'), "AIza[REDACTED]"),
    # Google OAuth tokens
    (re.compile(r'ya29\.[0-9A-Za-z\-_]{40,}'), "ya29.[REDACTED]"),
    # Azure / generic 32-char hex keys
    (re.compile(r'(?i)(api[_-]?key|subscription[_-]?key|ocp-apim-subscription-key)\s*[=:]\s*["\']?([a-f0-9]{32})["\']?'),
     r'\1=[REDACTED]'),
    # Generic password / secret / token assignments in config files
    (re.compile(r'(?i)(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token)\s*=\s*["\']([^"\']{4,})["\']'),
     r'\1="[REDACTED]"'),
    # The SAME assignment without quotes — which is how .env files are
    # actually written (`AZURE_OPENAI_API_KEY=abc123`, no quotes anywhere).
    # The quoted rule above missed every one of them, so a .env read, and now
    # a preview of a .env WRITE, carried real credentials into the model's
    # context, the SSE stream and the saved transcript.
    #
    # Matched on the whole line so the variable name can carry a prefix
    # (`AZURE_OPENAI_API_KEY`, `PROD_DB_PASSWORD`) — a bare-name pattern only
    # catches the tidy cases.
    #
    # Two deliberate restrictions keep this off SOURCE CODE, which matters now
    # that previews render diffs of the user's own files: mangling
    # `api_key = os.getenv("KEY")` into `api_key=[REDACTED]` hides a line that
    # never held a secret and makes the diff misleading.
    #   • NO whitespace around `=`. Config formats write `KEY=value`
    #     (.env, `export X=y`, docker-compose, CI env blocks); code writes
    #     `key = value`. That single character separates them almost perfectly.
    #   • The value must be unbroken by whitespace, so English prose
    #     ("the access token = the thing you pass") is left alone.
    # Spaced code assignments of string LITERALS — the genuinely risky code
    # case — are still caught by the quoted rule above.
    (re.compile(
        r'(?im)^(\s*(?:export |set )?[A-Za-z0-9_.\-]*'
        r'(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY'
        r'|CREDENTIALS?|CONNECTION_?STRING|DSN|CLIENT_?SECRET)'
        r'[A-Za-z0-9_.\-]*)=([^\s"\'][^\s]*)[ \t]*$'),
     r'\1=[REDACTED]'),
    # Bearer tokens
    (re.compile(r'(?i)(authorization\s*:\s*bearer\s+)[a-zA-Z0-9\-_\.]{20,}'),
     r'\1[REDACTED]'),
    # Basic auth in URLs: https://user:password@host
    (re.compile(r'(https?://[^:@\s]+):([^@\s]{4,})@'),
     r'\1:[REDACTED]@'),
    # Stripe keys
    (re.compile(r'sk_(?:live|test)_[a-zA-Z0-9]{24,}'), "sk_*_[REDACTED]"),
    (re.compile(r'pk_(?:live|test)_[a-zA-Z0-9]{24,}'), "pk_*_[REDACTED]"),
]


def redact_sensitive_content(text: str) -> str:
    """
    Replace known secret patterns in text with [REDACTED].
    Applied to tool output before it is returned to the LLM or streamed to the client.
    The variable NAME is preserved so the agent still understands the config structure.
    """
    if not text:
        return text
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text
