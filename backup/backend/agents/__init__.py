"""
agents package

Exposes the core agents, stop/resume registry, intent detector,
and workspace paths:

    from agents import OrchestratorAgent, ReActAgent
    from agents import StopRegistry, RunState
    from agents import detect_intent, enforce_floor
    from agents import ThreadWorkspace

Note: PlannerAgent still exists in planner_agent.py for reference
but is no longer used in the main flow. The orchestrator routes
directly to ReActAgent, which handles both simple and complex tasks.
"""

from .base_agent import BaseAgent
from .react_agent import ReActAgent, AgentStopped
from .tool_use_agent import ToolUseAgent
from .orchestrator import OrchestratorAgent
from .stop_registry import StopRegistry, RunState
from .intent_detector import detect_intent, enforce_floor, IntentResult
from .workspace_paths import ThreadWorkspace

__all__ = [
    "BaseAgent",
    "ReActAgent",
    "AgentStopped",
    "ToolUseAgent",
    "OrchestratorAgent",
    "StopRegistry",
    "RunState",
    "detect_intent",
    "enforce_floor",
    "IntentResult",
    "ThreadWorkspace",
]
