"""
Skill Tool — load one catalog entry's full instructions on demand.

The catalog in the system prompt carries only name + description, a line each.
This is the second level of the same progressive disclosure Claude Code and
GitHub Copilot use: the model reads the one-liners, decides, and pulls the
body it actually needs instead of paying for every framework file on every
turn.

What comes back is more than the text:

    · the body with {project-root}, {user_name}, {planning_artifacts} and the
      rest already substituted from the entry's parent config chain
    · any placeholder we could NOT fill, named alongside the config files
      that would hold it — so a gap becomes a read, not a guess
    · the entry's bundled files, listed
    · what it links to, so the model can follow the framework's own
      navigation instead of inventing capabilities

Reading the file directly with read_file works too — the catalog publishes the
path for exactly that reason. This tool exists because it does the resolution
and the link-listing that a raw read cannot.

Security: entry bodies are UNTRUSTED workspace content. They are size-capped
and injected as tool results, never as system instructions, and an entry's
declared tool list is persona guidance that never widens the request's
permission policy.
"""

import asyncio
import json
import uuid
from typing import List, Optional

from skills.catalog import SkillEntry, find_entry, load_body
from skills.closure import resolve_closure
from skills.variables import module_scope_for, render_unresolved, substitute
from utils.logger import get_logger

from .base_tool import BaseTool
from .client_broker import broker
from .client_delegating_tool import CLIENT_TOOL_TIMEOUT

log = get_logger(__name__)

# Same cap the persona injection uses (chars ≈ tokens*4) — one entry should
# not be able to swallow the turn's context.
_BODY_CAP = 12_000


class SkillTool(BaseTool):
    # The tool itself always runs on the SERVER — variable resolution and link
    # closure need the catalog, which the client doesn't have. When the
    # workspace is client-side it borrows the client's read_file to fetch the
    # body and does the resolution here, so Pattern C gets the full result
    # rather than a raw file.
    SUPPORTS_STREAMING = True

    name = "skill"

    description = (
        "Load the full instructions for a named entry from the <catalog> in "
        "your system prompt — an agent persona, skill, template, workflow, "
        "checklist, or any other kind the workspace defines. Returns the "
        "entry's complete text with its project variables already resolved, "
        "plus the files it bundles and the entries it links to. Call this "
        "BEFORE planning when an entry matches the task: its instructions "
        "take precedence over your defaults for this turn. Use the exact "
        "name from the catalog."
    )

    def __init__(self, workspace: str, catalog: Optional[List[SkillEntry]] = None,
                 session_scope: Optional[dict] = None,
                 client_reads: bool = False):
        super().__init__(workspace)
        self.catalog = catalog or []
        self.session_scope = session_scope or {}
        # True when read_file is client-delegated — i.e. the files live on the
        # user's machine and the server's own disk is the wrong place to look.
        self.client_reads = client_reads
        # Names loaded this run — the agent loop reads this to activate a
        # persona and to report which entry actually drove the turn.
        self.loaded: List[str] = []

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": (
                        "The entry's exact name from the <catalog>, e.g. "
                        "'migration' or 'bmad-agent-analyst'. Do not invent "
                        "names that are not listed."
                    ),
                },
            },
            "required": ["name"],
        }

    async def _fetch_via_client(self, path: str, on_event) -> Optional[str]:
        """Ask the connected client to read one file, reusing the same
        broker round-trip ClientDelegatingTool uses. Returns None on any
        failure — the caller then falls back to telling the model to read
        the file itself, which is never worse than what it had."""
        if on_event is None or not path:
            return None
        call_id = uuid.uuid4().hex
        fut = broker.create(self.thread_id, call_id)
        try:
            result = on_event("client_tool_use", {
                "id": call_id, "tool": "read_file", "input": {"path": path},
            })
            if asyncio.iscoroutine(result):
                await result
            output = await asyncio.wait_for(fut, timeout=CLIENT_TOOL_TIMEOUT)
        except (asyncio.TimeoutError, asyncio.CancelledError, RuntimeError) as e:
            broker.discard(self.thread_id, call_id)
            log.warning(f"skill: client read of {path} failed ({e})")
            return None
        if isinstance(output, dict):
            # The client's read_file result shape varies by transport; take
            # the first string field that looks like file text.
            for key in ("content", "text", "output", "result"):
                if isinstance(output.get(key), str):
                    return output[key]
            return None
        return output if isinstance(output, str) else None

    async def run(self, name: str = "", on_event=None):
        entry = find_entry(self.catalog, name)
        if entry is None:
            available = ", ".join(sorted(e.name for e in self.catalog)[:40])
            return (
                f"No catalog entry named '{name}'.\n"
                f"Available: {available or '(the catalog is empty)'}\n"
                f"Use a name exactly as it appears in the <catalog> block."
            )

        body = load_body(entry, self.workspace)
        if body is None and self.client_reads and not entry.is_builtin:
            # Pattern C: the file is on the user's machine. Borrow the
            # client's read_file so resolution still happens here, where the
            # catalog and the parent chain are.
            body = await self._fetch_via_client(entry.source, on_event)
            entry.body = body
        if body is None:
            return (
                f"Could not read '{entry.name}' from {entry.source or 'disk'}. "
                f"Read it directly with read_file(\"{entry.source}\") — the "
                f"file may live on the client machine, where read_file works "
                f"and this tool does not."
            )

        scope = dict(self.session_scope)
        scope.update(module_scope_for(self.workspace, entry.parent_chain,
                                      self.session_scope))
        resolved, unresolved = substitute(body, scope)
        closure = resolve_closure(entry, self.catalog)

        if entry.name not in self.loaded:
            self.loaded.append(entry.name)
        log.info(
            f"Skill loaded: '{entry.name}' (kind={entry.kind}, "
            f"origin={entry.origin}, links={len(closure.load_order) - 1}, "
            f"unresolved={unresolved or 'none'})"
        )

        header = f"# Entry: {entry.name} [{entry.kind}]"
        if entry.persona:
            header += f" — {entry.persona}"
            if entry.title:
                header += f", {entry.title}"
        if entry.source:
            header += f"\nSource: {entry.source}"

        sections = [header, "", resolved[:_BODY_CAP].strip()]
        if len(resolved) > _BODY_CAP:
            sections.append(
                f"\n[Truncated at {_BODY_CAP} characters — read "
                f"{entry.source} directly for the rest.]")

        note = render_unresolved(unresolved, entry.parent_chain)
        if note:
            sections += ["", note]

        links = closure.as_text()
        if links:
            sections += ["", links]

        if entry.kind == "agent":
            sections += ["", (
                "This entry is a PERSONA. Adopt it for the rest of the turn: "
                "follow its instructions, stay in its role, and keep it active "
                "if you load further skills. Drop it only when the user asks "
                "you to.")]
        elif entry.used_by:
            # A skill is the method; the agent is who runs it. Loading the
            # method alone gets the steps right and the role wrong.
            owners = ", ".join(
                f"{name} ({persona})" if persona else name
                for name, persona in zip(
                    entry.used_by,
                    entry.used_by_personas + [""] * len(entry.used_by))
            )
            sections += ["", (
                f"Owned by: {owners}. If you are acting on this skill for the "
                f"user's request, load that agent too with skill(\"...\") — it "
                f"carries the role, standards and gates this skill is written "
                f"to be used under.")]

        return "\n".join(sections)
