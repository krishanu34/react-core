"""
context package

Context window management: token estimation, budget allocation,
scratchpad compression, conversation summarization, and project scanning.
"""

from .token_estimator import estimate_tokens, estimate_messages_tokens
from .budget_manager import ContextBudget, allocate_budget, fit_to_budget
from .conversation_summarizer import ConversationSummarizer
from .project_scanner import scan_project, ProjectContext, invalidate_cache

__all__ = [
    "estimate_tokens",
    "estimate_messages_tokens",
    "ContextBudget",
    "allocate_budget",
    "fit_to_budget",
    "ConversationSummarizer",
    "scan_project",
    "ProjectContext",
    "invalidate_cache",
]
