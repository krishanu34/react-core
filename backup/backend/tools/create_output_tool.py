"""
Create Output Tool

Creates generated files (reports, summaries, documentation) in the
user's workspace directory — the same directory the user gave as their
workspace_path. Files appear right where the user expects them.

This is separate from file_write on purpose:
  - file_write    → create or overwrite source code files
  - code_edit     → modify existing source code files
  - create_output → generate deliverables (summaries, reports, .md docs)

When the user says "create a .md summary" or "generate a report",
use THIS tool. The output lands in their workspace, not in DevSphere's
internal folders.
"""

import os
from contextvars import ContextVar
from pathlib import Path

from utils.naming import slugify

from .base_tool import BaseTool
from .file_locks import file_lock

# The user's current request, bound per run by the router (same ContextVar
# isolation as context/permissions.py). Used ONLY to rescue generic
# deliverable names the model picks despite the prompt's naming rule.
_name_hint: ContextVar[str] = ContextVar("devsphere_output_name_hint", default="")

# Filename stems that say nothing about the question's domain.
_GENERIC_STEMS = {"summary", "report", "output", "document", "analysis", "notes", "doc"}


def set_output_name_hint(message: str) -> None:
    """Bind the current user request so generic deliverable names can be
    renamed after its domain ('summary.md' → 'payment-gateway-summary.md')."""
    _name_hint.set(message or "")


class CreateOutputTool(BaseTool):
    """
    Create a file in the thread's output directory.
    Used for generated reports, summaries, gap analyses,
    documentation — any deliverable the agent creates for the user.
    """

    name = "create_output"

    description = (
        "Create or append to a generated file (report, summary, documentation, "
        ".md, .txt, .csv, .html) in the user's workspace. Use this when the "
        "user asks you to CREATE a new document like a summary, gap analysis, "
        "report, or any deliverable. Set mode='append' to add content to an "
        "existing file (useful for building large reports incrementally). "
        "The file is saved directly in the user's workspace so they can see it. "
        "For editing existing code files, use code_edit or file_write instead."
    )

    def __init__(self, workspace: str, output_dir: str = None):
        """
        workspace:  the project root (required by BaseTool interface)
        output_dir: the thread's output directory where generated
                    files are saved. If None, falls back to workspace.
        """
        super().__init__(workspace)
        self._output_dir = output_dir or workspace

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": (
                        "Name of the output file to create or append to. "
                        "Derive it from the DOMAIN of the user's request, "
                        "kebab-case: a summary of the payment gateway → "
                        "'payment-gateway-summary.md'; a gap analysis of "
                        "auth → 'auth-gap-analysis.md'. NEVER use bare "
                        "generic names like 'summary.md' or 'report.md'. "
                        "Can include subdirectories: 'reports/api-review.md'"
                    )
                },
                "content": {
                    "type": "string",
                    "description": (
                        "The content to write (or append). Use markdown "
                        "formatting for .md files. Write well-structured "
                        "content with headings, bullet points, etc."
                    )
                },
                "mode": {
                    "type": "string",
                    "description": (
                        "Write mode: 'write' to create/overwrite the file "
                        "(default), 'append' to add content to the end of "
                        "an existing file. Use 'append' when building large "
                        "reports incrementally — write the header first, then "
                        "append batches of content."
                    )
                }
            },
            "required": ["filename", "content"]
        }

    async def run(self, filename, content, mode="write"):
        clean_name = filename.replace("..", "").lstrip("/\\")
        clean_name = self._domain_name(clean_name)
        file_path = Path(self._output_dir) / clean_name

        try:
            file_path.parent.mkdir(parents=True, exist_ok=True)
            # mode="append" is a read → modify → write, and the model routinely
            # emits several create_output calls for ONE deliverable in a single
            # concurrent batch. Unlocked, both appends read the same original
            # text and the second write discards the first — with both calls
            # reporting "appended". See tools/file_locks.py.
            async with file_lock(str(file_path)):
                if mode == "append" and file_path.exists():
                    existing = file_path.read_text(encoding="utf-8")
                    combined = existing + "\n" + content
                    file_path.write_text(combined, encoding="utf-8")
                    return {
                        "status": "appended",
                        "filename": clean_name,
                        "path": str(file_path),
                        "appended_size": len(content.encode("utf-8")),
                        "total_size": len(combined.encode("utf-8")),
                        "total_lines": combined.count("\n") + 1,
                        "message": f"Appended to {clean_name} (+{len(content)} chars, total {len(combined)} chars)",
                    }
                else:
                    file_path.write_text(content, encoding="utf-8")
                    return {
                        "status": "created",
                        "filename": clean_name,
                        "path": str(file_path),
                        "size": len(content.encode("utf-8")),
                        "lines": content.count("\n") + 1,
                        "message": f"Output file created: {clean_name} ({len(content)} chars)",
                    }
        except Exception as e:
            return {"error": f"Failed to create output file: {str(e)}"}

    @staticmethod
    def _domain_name(clean_name: str) -> str:
        """Naming guard: when the model still picks a generic stem
        ('summary.md') despite the schema rule, prefix it with the domain of
        the current request ('payment-gateway-summary.md'). Deterministic per
        request, so mode='append' keeps hitting the same file within a run.
        No hint bound (e.g. resume flow) → leave the name untouched."""
        p = Path(clean_name)
        stem = p.stem.lower()
        if stem not in _GENERIC_STEMS:
            return clean_name
        hint = _name_hint.get()
        if not hint:
            return clean_name
        topic = slugify(hint)
        if topic == "feature" or topic == stem:
            return clean_name
        return str(p.with_name(f"{topic}-{stem}{p.suffix}")).replace("\\", "/")
