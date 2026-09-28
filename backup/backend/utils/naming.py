"""
Domain-based naming — shared by the spec workflow (feature folder slugs)
and create_output (deliverable filename guard).

The goal is Claude Code-like names: derived from WHAT the request is about,
not HOW it was phrased. "I want to create a login page" must yield
'login-page', never 'i-want-create-a'. The LLM picks names first (it sees
the whole request); these helpers are the deterministic fallback and the
guard against generic names slipping through.
"""

import re

# Request phrasing that never belongs in a name: pronouns, articles, modals,
# politeness, and generic build verbs. Domain nouns (login, api, payment,
# dashboard, ...) are deliberately NOT here — they ARE the name.
STOPWORDS = {
    "i", "we", "you", "me", "my", "our", "us",
    "a", "an", "the", "to", "of", "in", "on", "for", "with", "and", "or",
    "is", "are", "be", "it", "this", "that", "there",
    "want", "wants", "need", "needs", "would", "like", "please",
    "can", "could", "should", "will", "help", "let", "lets",
    "create", "build", "make", "add", "implement", "develop", "generate",
    "write", "setup", "set", "up", "new", "some", "using",
    "summarize", "summarise", "analyze", "analyse", "explain", "describe",
    "give", "show", "tell", "about",
    # spec-kit / BMAD keywords a message may start with ("/specify ...")
    "specify", "plan", "tasks", "clarify",
}


def slugify(text: str, max_words: int = 4) -> str:
    """'I want to create a login page with JWT!' → 'login-page-jwt'

    Keeps the first `max_words` domain words after dropping request filler.
    If filtering eats everything ("I want to make it"), falls back to the
    raw words so the result is never empty."""
    words = re.findall(r"[a-z0-9]+", text.lower())
    meaningful = [w for w in words if w not in STOPWORDS]
    return "-".join((meaningful or words)[:max_words]) or "feature"
