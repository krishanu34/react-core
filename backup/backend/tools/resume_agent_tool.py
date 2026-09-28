"""
resume_agent — continue a sub-agent that already finished, with its full history.

Without this, the only way to get more work out of a completed child is to spawn
a fresh one, which starts blind: it re-reads the same files and re-derives the
same conclusions, and can contradict what the first one decided. Resuming keeps
the original agent's reasoning intact and just adds the follow-up.

    sub_agent(role="reviewer", task="find perf issues")   → 3 findings
    resume_agent(agent_id=..., message="now fix finding 2")
        → the SAME agent, which already knows what finding 2 is

The message history comes from the child's checkpoint (context/checkpoint.py),
which `_finish` already writes on every terminal status. So resume needs no new
storage: it reuses the durability layer built for crash recovery. That also
means a resume survives a process restart, as long as the checkpoint is intact.
"""

from __future__ import annotations

from .base_tool import BaseTool
from context import checkpoint
from utils.logger import get_logger

log = get_logger(__name__)

# A resumed agent is a fresh run of an existing conversation, so it gets its own
# step allowance rather than inheriting the exhausted one from before.
_RESUME_MESSAGE_CAP = 8_000


class ResumeAgentTool(BaseTool):
    name = "resume_agent"
    description = (
        "Continue a sub-agent that already finished, keeping everything it "
        "learned. Use this instead of spawning a new agent whenever the "
        "follow-up work depends on what the first agent found — it still has "
        "its files, findings and reasoning in context. Give it the agent_id "
        "from the earlier sub_agent result."
    )

    def __init__(self, workspace: str, llm=None, tool_registry=None,
                 token_tracker=None, context_window=8192, thread_id="default",
                 depth=0):
        super().__init__(workspace)
        self._llm = llm
        self._parent_registry = tool_registry
        self._token_tracker = token_tracker
        self._context_window = context_window
        self.thread_id = thread_id
        self._depth = depth

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "agent_id": {
                    "type": "string",
                    "description": (
                        "The agent_id returned by the earlier sub_agent call."
                    ),
                },
                "message": {
                    "type": "string",
                    "description": (
                        "The follow-up instruction. Written as if speaking to "
                        "the agent mid-conversation — it remembers its previous "
                        "work, so don't repeat context it already has."
                    ),
                },
            },
            "required": ["agent_id", "message"],
        }

    async def run(self, agent_id, message, on_event=None, should_stop=None):
        if not self._llm:
            return {"error": "resume_agent not configured: no LLM available"}
        if not self._parent_registry:
            return {"error": "resume_agent not configured: no tool registry"}

        agent_id = str(agent_id or "").strip()
        if not agent_id:
            return {"error": "agent_id is required."}

        saved = checkpoint.load(self.thread_id, agent_id)
        if not saved:
            return {
                "status": "error",
                "error": (
                    f"No agent '{agent_id}' found for this conversation. Check "
                    f"the agent_id from the sub_agent result, or spawn a new "
                    f"agent instead."
                ),
            }

        prior = saved.get("messages")
        if not isinstance(prior, list) or not prior:
            return {
                "status": "error",
                "error": (
                    f"Agent '{agent_id}' has no recoverable history. Spawn a "
                    f"new agent for this work."
                ),
            }

        role = saved.get("role") or "subagent"
        # Same derived namespace as the original run, so the resumed agent keeps
        # its own read tracker / task list rather than inheriting the parent's.
        child_thread = f"{self.thread_id}::sub::{agent_id}"

        from agents.factory import build_agent
        from .sub_agent_tool import SubAgentTool, _summarize_task

        # Rebuild the child's tool set from the parent's live instances, exactly
        # as a fresh spawn does (see sub_agent_tool.run) so client-delegation
        # wrappers and per-thread isolation are preserved.
        import copy as _copy
        from .registry import ToolRegistry

        child_tools = []
        for t in self._parent_registry.list_tools():
            if t.name in ("ask_user", "resume_agent"):
                continue
            clone = _copy.copy(t)
            clone.thread_id = child_thread
            child_tools.append(clone)
        if not child_tools:
            return {"error": "No tools available to resume this agent."}

        child_registry = ToolRegistry(child_tools)

        child_agent = build_agent(
            llm=self._llm,
            tool_registry=child_registry,
            token_tracker=self._token_tracker,
            context_window=self._context_window,
            thread_id=child_thread,
            agent_id=agent_id,
            parent_agent_id=saved.get("parent_agent_id"),
            agent_role=role,
        )

        # The prior conversation is replayed to the agent as a recap inside its
        # prompt rather than injected as raw messages. Raw injection would be
        # closer to a true resume, but it also re-imports every tool result the
        # original run accumulated — refilling the context window that the
        # checkpoint's own compaction had already trimmed. The recap keeps the
        # conclusions, which is what the follow-up actually needs.
        history = self._render_history(prior)

        await self._emit(on_event, "subagent_start", {
            "agent_id": agent_id, "role": role,
            "task": _summarize_task(message),
            "tools": child_registry.names(), "owns_paths": [],
            "depth": self._depth + 1, "parent_agent_id": "",
            "resumed": True,
        })

        log.info(f"Resuming subagent {agent_id} (role={role})")

        prompt = (
            f"## Continuing your earlier work\n"
            f"You already worked on this task and reported back. Here is what "
            f"you did, for your own reference:\n\n{history}\n\n"
            f"---\n\n## Follow-up instruction\n{message}"
        )

        try:
            result = await child_agent.run(
                prompt, memory_context="", on_event=on_event,
                should_stop=should_stop,
            )
        except Exception as e:  # noqa: BLE001 — never kill the parent
            log.error(f"Resume of {agent_id} failed: {type(e).__name__}: {e}")
            await self._emit(on_event, "subagent_done", {
                "agent_id": agent_id, "role": role, "status": "error",
                "summary": f"{type(e).__name__}: {e}",
            })
            return {"status": "error", "agent_id": agent_id,
                    "error": f"Resume failed: {type(e).__name__}: {e}"}

        report = SubAgentTool._parse_report(result.get("answer", ""))
        status = result.get("status", "unknown")
        if status == "done" and report["files_changed"] and not report["verification"]:
            status = "unverified"

        await self._emit(on_event, "subagent_done", {
            "agent_id": agent_id, "role": role, "status": status,
            "steps": result.get("steps_taken", 0),
            "files_changed": report["files_changed"],
            "summary": report["summary"],
        })

        return {
            "status": status,
            "agent_id": agent_id,
            "role": role,
            "resumed": True,
            **report,
            "steps_taken": result.get("steps_taken", 0),
        }

    @staticmethod
    def _render_history(messages: list) -> str:
        """
        Condense the saved transcript into the agent's own recap.

        Capped, and tool results are elided to one line: the point is to restore
        the agent's CONCLUSIONS, not to replay every byte it read — replaying
        those would refill the context window the resume is meant to keep lean.
        """
        parts: list[str] = []
        for m in messages:
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            content = m.get("content")
            if role == "system" or not isinstance(content, str) or not content.strip():
                continue
            if role == "tool":
                first = content.strip().splitlines()[0][:160]
                parts.append(f"- (tool result) {first}")
            elif role == "assistant":
                parts.append(f"- You: {content.strip()[:600]}")
            elif role == "user":
                parts.append(f"- Instruction: {content.strip()[:400]}")

        text = "\n".join(parts)
        if len(text) > _RESUME_MESSAGE_CAP:
            # Keep the END: the most recent reasoning is what the follow-up
            # builds on, and the earliest setup is the most expendable.
            text = "…(earlier steps omitted)…\n" + text[-_RESUME_MESSAGE_CAP:]
        return text or "(no recoverable detail)"

    async def _emit(self, on_event, event_type: str, data: dict):
        if on_event is None:
            return
        res = on_event(event_type, data)
        if res is not None:
            await res
