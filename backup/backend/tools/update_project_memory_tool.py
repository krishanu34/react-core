"""
Update Project Memory Tool — the DevSphere equivalent of Claude Code's /remember

Claude Code writes persistent project facts to CLAUDE.md in the workspace so
every future session picks them up automatically. We do the same thing using
devaccel.md in the user's workspace root.

WHEN TO CALL THIS:
  - User confirms a tech stack → save it under ## Stack
  - You create a new project   → save structure under ## Architecture
  - You discover the run/build commands → save under ## Commands
  - An important design choice is made → save under ## Decisions
  - Anything else worth knowing for future sessions → ## Notes

FORMAT (devaccel.md is plain markdown):

  # DevAccel Project Memory
  > Auto-maintained by the DevSphere agent. Edit freely.

  ## Stack
  React 18 + TypeScript frontend, Express + MongoDB backend (MERN).

  ## Architecture
  src/components/ — React UI
  server/routes/  — Express API routes
  server/models/  — Mongoose schemas

  ## Commands
  npm run dev      — start both frontend and backend (concurrently)
  npm run build    — production build
  npm test         — Jest unit tests

  ## Decisions
  - JWT stored in httpOnly cookie (not localStorage) for XSS safety.
  - MongoDB Atlas used in prod; local MongoDB for dev.

  ## Notes
  User prefers TypeScript strict mode. Avoid any-casts.

APPEND vs REPLACE:
  mode="append"  — adds content to the end of an existing section
                   (good for decisions and notes — they accumulate)
  mode="replace" — overwrites the whole section
                   (good for Stack/Commands which have one definitive state)
"""

from pathlib import Path
from .base_tool import BaseTool
from .file_locks import file_lock

_HEADER = "# DevAccel Project Memory\n> Auto-maintained by the DevSphere agent. Edit freely.\n\n"
_VALID_SECTIONS = {"Stack", "Architecture", "Commands", "Decisions", "Notes"}


def _parse_sections(text: str) -> dict:
    """Split devaccel.md into a dict of section_name -> body_text."""
    sections: dict[str, str] = {}
    current_section: str | None = None
    current_lines: list[str] = []
    preamble: list[str] = []

    for line in text.splitlines(keepends=True):
        if line.startswith("## "):
            if current_section is not None:
                sections[current_section] = "".join(current_lines)
            elif current_lines:
                preamble.extend(current_lines)
            current_section = line[3:].strip()
            current_lines = []
        else:
            current_lines.append(line)

    if current_section is not None:
        sections[current_section] = "".join(current_lines)
    else:
        preamble.extend(current_lines)

    sections["__preamble__"] = "".join(preamble)
    return sections


def _render_sections(sections: dict, section_order: list[str]) -> str:
    """Re-assemble sections back into markdown text."""
    parts: list[str] = []
    preamble = sections.get("__preamble__", "")
    if preamble:
        parts.append(preamble)

    for name in section_order:
        body = sections.get(name)
        if body is None:
            continue
        # Ensure body has exactly one trailing newline before next section
        body_stripped = body.rstrip("\n")
        parts.append(f"## {name}\n{body_stripped}\n\n")

    return "".join(parts).rstrip("\n") + "\n"


# Section display order
_SECTION_ORDER = ["Stack", "Architecture", "Commands", "Decisions", "Notes"]


class UpdateProjectMemoryTool(BaseTool):

    name = "update_project_memory"

    description = (
        "Persist important project facts to devaccel.md in the workspace root "
        "so every future session automatically has context about this project. "
        "Call this whenever you learn something durable: the tech stack chosen, "
        "how the project is structured, key commands to run/build/test it, "
        "important architectural decisions, or user preferences. "
        "Sections: Stack | Architecture | Commands | Decisions | Notes. "
        "Use mode='replace' to overwrite a section (e.g., after the stack is "
        "confirmed), mode='append' to add to it (e.g., a new decision)."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "section": {
                    "type": "string",
                    "enum": list(_VALID_SECTIONS),
                    "description": (
                        "Which section to write. "
                        "Stack: tech stack & languages. "
                        "Architecture: directory structure & module roles. "
                        "Commands: how to run/build/test. "
                        "Decisions: architectural or design choices made. "
                        "Notes: user preferences or anything else."
                    ),
                },
                "content": {
                    "type": "string",
                    "description": (
                        "Text to write into the section. Plain prose or "
                        "a short bulleted list. Be concise — this is a "
                        "reference card, not documentation."
                    ),
                },
                "mode": {
                    "type": "string",
                    "enum": ["append", "replace"],
                    "description": (
                        "append (default) — add content to the existing section. "
                        "replace — overwrite the section entirely."
                    ),
                },
            },
            "required": ["section", "content"],
        }

    async def run(self, section: str, content: str, mode: str = "append") -> dict:
        if section not in _VALID_SECTIONS:
            return {
                "error": f"Unknown section '{section}'. Valid: {sorted(_VALID_SECTIONS)}",
            }

        # Never write project memory into the product's own deployment folder
        # (server-default fallback workspace) — that file is shared across
        # every fallback thread, so one user's memory would leak into
        # another's context.
        from .run_terminal_tool import _self_exposure_reason
        reason = _self_exposure_reason(self.workspace)
        if reason:
            return {
                "error": (
                    f"Project memory not saved: {reason}. No user workspace is "
                    f"bound for this thread — tell the user to open/select a "
                    f"workspace folder first."
                ),
            }

        path = Path(self.workspace) / "devaccel.md"

        # Parse → modify → re-render → write is a read-modify-write on one
        # shared file, and the model often records two facts (architecture +
        # conventions) as two calls in the SAME concurrent batch. Unlocked,
        # both parse the pre-update text and the second render overwrites the
        # first section — both calls still report success. See file_locks.py.
        async with file_lock(str(path)):
            # ── Read existing file ─────────────────────────────────────────
            if path.exists():
                existing_text = path.read_text(encoding="utf-8", errors="replace")
                # Strip old header if present (we'll re-add it)
                if existing_text.startswith("# DevAccel"):
                    # Remove the first two lines (title + subtitle) + blank line
                    lines = existing_text.split("\n", 3)
                    existing_text = lines[3] if len(lines) > 3 else ""
                sections = _parse_sections(existing_text)
            else:
                sections = {"__preamble__": ""}

            # ── Apply update ───────────────────────────────────────────────
            content = content.strip()
            existing_body = sections.get(section, "").strip()

            if mode == "replace" or not existing_body:
                sections[section] = content + "\n"
            else:  # append
                sections[section] = existing_body + "\n" + content + "\n"

            # ── Render + write ─────────────────────────────────────────────
            new_text = _HEADER + _render_sections(sections, _SECTION_ORDER)
            try:
                path.write_text(new_text, encoding="utf-8")
            except OSError as e:
                return {"error": f"Could not write devaccel.md: {e}"}

        preview = sections[section].strip()
        if len(preview) > 120:
            preview = preview[:120] + "…"

        return {
            "status": "updated",
            "file": str(path),
            "section": section,
            "mode": mode,
            "preview": preview,
        }
