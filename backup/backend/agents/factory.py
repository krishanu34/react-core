"""
Agent Factory — one place that decides WHICH agent loop runs.

Before this existed, the choice lived only inside
OrchestratorAgent._create_agent(), so every OTHER caller that needed an agent
had to duplicate the branch — and SubAgentTool didn't: it hardcoded ReActAgent
while the system default is AGENT_MODE=tool_use. Sub-agents therefore ran a
strictly weaker loop than the parent that spawned them (JSON parsing instead of
native function calling), which is exactly backwards: a delegated subtask is
usually the HARDER half of the work.

Keeping the branch here means "how do we build an agent" has one answer, and a
sub-agent is the same kind of thing as its parent by construction.

ReActAgent takes no thread_id (it has no per-thread state of its own), so that
argument is only forwarded to ToolUseAgent.
"""

import os

from utils.logger import get_logger

log = get_logger(__name__)

# "tool_use" (native function calling, default) or "react" (JSON parsing fallback).
# Read at call time, not import time, so tests can flip it with monkeypatch.
_DEFAULT_MODE = "tool_use"


def agent_mode() -> str:
    return os.getenv("AGENT_MODE", _DEFAULT_MODE).lower()


def build_agent(
    llm,
    tool_registry=None,
    memory=None,
    token_tracker=None,
    context_window: int = 8192,
    thread_id: str = "default",
    agent_id: str = None,
    parent_agent_id: str = None,
    agent_role: str = "",
    max_run_tokens: int = None,
    quota_probe=None,
):
    """
    Build the agent loop selected by AGENT_MODE, bound to `tool_registry`.

    Used by OrchestratorAgent for the top-level run and by SubAgentTool for
    every spawned child, so both sides of a delegation run the same loop.

    agent_id / parent_agent_id / agent_role identify this agent within the run
    and are what checkpoints are keyed on (context/checkpoint.py), so a resume
    can re-run only the branches of a fan-out that never finished. ReActAgent
    has no checkpointing, so they are only forwarded to ToolUseAgent.

    max_run_tokens is this caller's per-run ceiling from their token quota, and
    None means "use MAX_AGENT_TOKENS" — the env default that was the only
    setting before quotas existed.
    """
    from .react_agent import ReActAgent
    from .tool_use_agent import ToolUseAgent

    if agent_mode() == "tool_use":
        return ToolUseAgent(
            llm=llm,
            tool_registry=tool_registry,
            memory=memory,
            token_tracker=token_tracker,
            context_window=context_window,
            thread_id=thread_id,
            agent_id=agent_id,
            parent_agent_id=parent_agent_id,
            agent_role=agent_role,
            max_run_tokens=max_run_tokens,
            quota_probe=quota_probe,
        )

    return ReActAgent(
        llm=llm,
        tool_registry=tool_registry,
        memory=memory,
        token_tracker=token_tracker,
        context_window=context_window,
    )
