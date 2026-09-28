"""
Intent Detector - Deterministic Pre-Classifier

This runs BEFORE the LLM classifier (orchestrator._classify) and
costs zero tokens. It uses pattern matching and keyword detection
to produce an "intent signal" that tells the orchestrator:

  - What the minimum classification should be (the FLOOR)
  - What intent signals were detected and why
  - Whether the LLM is allowed to downgrade the classification

WHY THIS EXISTS (the core insight):

  Prompt-based classification is unreliable. You can write "NEVER
  classify workspace questions as direct" in the prompt, and the LLM
  will still do it ~20% of the time. That's how LLMs work - they're
  probabilistic, not rule-followers.

  Production systems (Copilot, Claude Code, Cursor) solve this the
  same way: deterministic rules run first, set a floor, and the LLM
  can only UPGRADE the classification (simple -> complex), never
  DOWNGRADE it (simple -> direct).

  The flow becomes:

    User message
        |
        v
    IntentDetector (deterministic, free, 100% reliable)
        |  "minimum_route = simple_task because user said 'workspace'"
        v
    LLM Classifier (probabilistic, costs tokens)
        |  "I think this is direct"  <-- BLOCKED, floor is simple_task
        |  "I think this is complex" <-- ALLOWED, above the floor
        v
    Final classification

HOW THE SCORING WORKS:

  Each pattern/keyword has a category and a weight. When matched,
  it contributes to an intent score. The highest-scoring intent
  determines the minimum route:

    score >= WORKSPACE_THRESHOLD  -> minimum is simple_task
    score >= MULTI_FILE_THRESHOLD -> minimum is complex_task
    score < WORKSPACE_THRESHOLD   -> no floor, LLM decides freely

  This means:
    "hi"                          -> no signals, LLM decides (direct)
    "what is a closure"           -> no signals, LLM decides (direct)
    "analyze my workspace"        -> workspace signal, floor=simple_task
    "read config.json"            -> file signal, floor=simple_task
    "refactor all models"         -> multi-file signal, floor=complex_task
"""

import re
from dataclasses import dataclass, field
from typing import List, Tuple


@dataclass
class IntentSignal:
    """One detected signal from the user's message."""
    category: str       # e.g. "workspace_reference", "file_operation"
    matched_text: str   # the actual text that triggered this signal
    weight: float       # how strongly this signal suggests tool use
    reason: str         # human-readable explanation


@dataclass
class IntentResult:
    """
    Output of the intent detector. Passed to the orchestrator so it
    can enforce the floor and include signals in the LLM prompt.
    """
    # The minimum classification the LLM is NOT allowed to go below.
    # "none" means no floor - LLM decides freely.
    # "simple_task" means LLM can say simple_task or complex_task, but NOT direct.
    # "complex_task" means LLM must say complex_task.
    minimum_route: str = "none"

    # All signals detected, for debugging and prompt injection
    signals: List[IntentSignal] = field(default_factory=list)

    # Total score (sum of all signal weights)
    total_score: float = 0.0

    # Human-readable summary of why this minimum was set
    reasoning: str = ""


# ── Thresholds ───────────────────────────────────────────────────
# These control how many signals need to fire before we set a floor.
# Tuned conservatively: we'd rather let the LLM decide on borderline
# cases than incorrectly force tool use on a genuine knowledge question.

SIMPLE_TASK_THRESHOLD = 1.0   # one strong signal is enough
COMPLEX_TASK_THRESHOLD = 3.0  # needs multiple strong signals


# ── Pattern definitions ──────────────────────────────────────────
# Each tuple: (compiled regex, category, weight, reason template)
# Patterns are checked against the LOWERCASED input.
# {0} in reason is replaced with the matched text.

_PATTERNS: List[Tuple[re.Pattern, str, float, str]] = []


def _p(pattern: str, category: str, weight: float, reason: str):
    """Helper to register a pattern."""
    _PATTERNS.append((re.compile(pattern, re.IGNORECASE), category, weight, reason))


# --- Workspace / project references (strong signals) ---
# If the user mentions THEIR workspace/project/code, they want us to LOOK at it.

_p(r"\b(my|this|the|our|current)\s+(workspace|project|codebase|repo|repository|code)\b",
   "workspace_reference", 2.0,
   "References their specific workspace/project: '{0}'")

_p(r"\b(workspace|project)\s+(structure|layout|organization|architecture)\b",
   "workspace_reference", 2.0,
   "Asking about project structure: '{0}'")

_p(r"\banalyze\b.*\b(workspace|project|code|codebase|directory|folder|repo)\b",
   "workspace_action", 2.0,
   "Requesting workspace analysis: '{0}'")

_p(r"\b(analyze|inspect|examine|audit|scan|explore|review|check)\s+(my|this|the|our)\b",
   "workspace_action", 1.5,
   "Action verb targeting user's content: '{0}'")

# --- File operations (strong signals) ---
# Any mention of reading/writing/finding specific files means tools.

_p(r"\bread\b.*\b(file|config|readme|package|requirements)\b",
   "file_operation", 2.0,
   "Wants to read a specific file: '{0}'")

_p(r"\b(read_file|file_write|code_edit|grep_search|file_search|list_directory|run_terminal|project_context)\b",
   "tool_reference", 2.0,
   "Directly references a tool name: '{0}'")

_p(r"[\w./\\]+\.(py|js|ts|jsx|tsx|json|yaml|yml|md|txt|html|css|toml|cfg|ini|sql|sh|bat)\b",
   "file_path", 1.5,
   "Contains a file path/name: '{0}'")

_p(r"\b(find|search|grep|look for|locate)\b.*\b(file|function|class|variable|import|todo|bug|error)\b",
   "search_operation", 1.5,
   "Searching for something in the codebase: '{0}'")

_p(r"\b(list|show|what('s| is) in)\b.*\b(directory|folder|dir|files)\b",
   "directory_operation", 1.5,
   "Listing directory contents: '{0}'")

# --- Execution / command signals ---

_p(r"\b(run|execute|start|build|test|install|deploy|compile)\b.*\b(command|script|tests?|server|app)\b",
   "execution", 1.5,
   "Wants to execute something: '{0}'")

_p(r"\brun\s+(the\s+)?(tests?|server|app|build|script|command)\b",
   "execution", 2.0,
   "Direct execution request: '{0}'")

# --- Multi-file / complex signals ---
# These push the floor toward complex_task.

_p(r"\b(refactor|migrate|rename|move|reorganize)\b.*\b(all|every|each|across)\b",
   "multi_file", 2.0,
   "Multi-file operation: '{0}'")

_p(r"\b(add|implement|create|build)\s+(a\s+)?(\w+\s+)*(feature|authentication|auth|api|endpoint|module|component|service|middleware|route|page|view)\b",
   "feature_work", 1.5,
   "Feature implementation: '{0}'")

# --- Project / app / website creation (STRONG signal) ---
# "create a website", "build an app", "make a project" = ALWAYS agent route.
# This is multi-file work that requires file_write, run_terminal, etc.

_p(r"\b(create|build|make|develop|set\s*up|scaffold|generate|bootstrap|init)\s+(a\s+|an\s+|the\s+|my\s+|complete\s+|full\s+|simple\s+|basic\s+)?(\w+\s+)*(website|web\s*site|webapp|web\s*app|application|app|project|system|platform|dashboard|portal|tool|cli|server|backend|frontend|microservice|library|package|module|plugin|extension|bot|chatbot|game|saas|mvp|prototype|landing\s*page|blog|cms|crm|erp|store|shop|e-?commerce|marketplace)\b",
   "feature_work", 3.0,
   "Project/app creation request: '{0}'")

_p(r"\b(create|build|make|develop|write)\s+(me\s+)?(a\s+|an\s+)?(\w+\s+){0,3}(in|using|with)\s+(react|vue|angular|next|django|flask|fastapi|express|rails|laravel|spring|go|rust|python|node|typescript)\b",
   "feature_work", 3.0,
   "Create project with specific tech stack: '{0}'")

_p(r"\b(set\s*up|initialize|scaffold|bootstrap|generate)\s+(a\s+|an\s+|the\s+|new\s+)?(\w+\s+)*(project|repo|repository|workspace|codebase|boilerplate|template|starter)\b",
   "feature_work", 2.5,
   "Project setup/scaffolding: '{0}'")

# --- Code writing / generation signals ---
# "write a function", "implement the login", "code the API" = needs tools

_p(r"\b(write|code|implement|program|develop)\s+(a\s+|an\s+|the\s+|me\s+)?(\w+\s+)*(function|class|method|handler|controller|model|schema|migration|test|script|module|util|helper|hook|decorator|middleware|guard|interceptor|resolver|factory|adapter|wrapper|config|setup|installer)\b",
   "feature_work", 2.0,
   "Code writing request: '{0}'")

_p(r"\b(write|generate|create)\s+(the\s+|some\s+)?(code|implementation|logic|solution)\b",
   "feature_work", 2.0,
   "Code generation request: '{0}'")

_p(r"\b(all|every|each)\s+(file|module|component|class|function)s?\b",
   "multi_file", 1.5,
   "Targets multiple files: '{0}'")

_p(r"\b(across|throughout)\s+(the\s+)?(project|codebase|repo|workspace)\b",
   "multi_file", 1.5,
   "Scope spans entire project: '{0}'")

# --- Technology / dependency questions about THIS project ---

_p(r"\bwhat\s+(technologies?|frameworks?|dependencies|packages?|libraries?)\b.*\b(use|using|have|does)\b",
   "project_inquiry", 1.5,
   "Asking about project's technology stack: '{0}'")

_p(r"\b(how|what)\s+(does|is)\s+(this|the)\s+(project|app|code|system)\b",
   "project_inquiry", 1.5,
   "Asking about the project itself: '{0}'")

_p(r"\b(explain|describe|summarize|overview)\b.*\b(architecture|structure|codebase|project)\b",
   "project_inquiry", 1.5,
   "Wants project overview: '{0}'")

_p(r"\b(list|show|give)\b.*\b(all|every|each)\b.*\b(file|files)\b",
   "multi_file", 2.0,
   "Listing all files in workspace: '{0}'")

_p(r"\b(purpose|summary|description)\b.*\b(each|every|all)\s+(file|files)\b",
   "multi_file", 2.0,
   "Wants purpose of all files: '{0}'")


# ── Main detection function ──────────────────────────────────────

def detect_intent(user_input: str) -> IntentResult:
    """
    Analyze the user's message for intent signals.

    This is the function the orchestrator calls BEFORE the LLM
    classifier. It returns an IntentResult with:
      - minimum_route: the floor the LLM cannot go below
      - signals: all detected patterns (for debugging/prompt)
      - reasoning: human-readable explanation

    This function is:
      - Deterministic (same input always gives same output)
      - Free (no LLM calls, no API calls, no I/O)
      - Fast (just regex matching)
      - 100% reliable (no probabilistic behavior)
    """
    signals: List[IntentSignal] = []

    for pattern, category, weight, reason_template in _PATTERNS:
        match = pattern.search(user_input)
        if match:
            matched_text = match.group(0)
            signals.append(IntentSignal(
                category=category,
                matched_text=matched_text,
                weight=weight,
                reason=reason_template.format(matched_text),
            ))

    total_score = sum(s.weight for s in signals)

    # Determine the floor based on signal categories, not just score.
    #
    # Key insight: multiple workspace signals (e.g. "analyze my
    # workspace" triggers 3 patterns) should NOT escalate to
    # complex_task. Only multi_file and feature_work categories
    # indicate genuinely complex, multi-step work.
    #
    # Floor logic:
    #   - multi_file or feature_work signal? -> complex_task
    #   - any other tool-requiring signal?   -> simple_task
    #   - no signals at all?                 -> none (LLM decides)
    minimum_route = "none"
    has_multi = any(s.category == "multi_file" for s in signals)
    has_feature = any(s.category == "feature_work" for s in signals)

    if has_multi or has_feature:
        minimum_route = "complex_task"
    elif total_score >= SIMPLE_TASK_THRESHOLD:
        minimum_route = "simple_task"

    # Build reasoning summary
    if signals:
        signal_summary = "; ".join(s.reason for s in signals[:3])
        reasoning = (
            f"Detected {len(signals)} intent signal(s) "
            f"(score={total_score:.1f}): {signal_summary}"
        )
    else:
        reasoning = "No workspace/tool intent signals detected - LLM decides freely"

    return IntentResult(
        minimum_route=minimum_route,
        signals=signals,
        total_score=total_score,
        reasoning=reasoning,
    )


def enforce_floor(llm_classification: str, intent_result: IntentResult) -> str:
    """
    Apply the intent detector's floor to the LLM's classification.

    The LLM can UPGRADE (simple->complex) but never DOWNGRADE
    (simple->direct) below the floor.

    This is the function that makes the system reliable:
    even if the LLM says "direct", if the intent detector found
    workspace signals, we override to at least "simple_task".

    Returns the final classification to use.
    """
    # Route priority: direct < simple_task < complex_task
    priority = {"none": -1, "direct": 0, "simple_task": 1, "complex_task": 2}

    floor_priority = priority.get(intent_result.minimum_route, -1)
    llm_priority = priority.get(llm_classification, 0)

    if llm_priority < floor_priority:
        # LLM tried to downgrade below the floor - override it
        return intent_result.minimum_route

    # LLM classification is at or above the floor - keep it
    return llm_classification
