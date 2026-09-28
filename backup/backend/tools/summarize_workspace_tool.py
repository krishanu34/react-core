"""
Summarize Workspace Tool — Hybrid Approach

Phase 1 (Python): Walk all files, extract raw context (first 25 lines,
  docstrings, imports, class/function names) — fast, free, no LLM.

Phase 2 (LLM): Send file contexts in batches to the LLM and ask it
  to write a one-line purpose description for each file — accurate,
  contextual, like Claude Code.

Phase 3 (Python): Assemble the markdown and write directly to output.

Why hybrid?
  - Pure Python extraction gives weak 3-word descriptions
  - Pure LLM iteration (ReAct loop) stops after 4 steps on 138 files
  - Hybrid: Python collects ALL data, LLM describes in 5-10 batch calls,
    Python writes the complete file. Reliable + high quality.
"""

import os
from pathlib import Path
from collections import defaultdict

from .base_tool import BaseTool
from context import scan_policy
from utils.logger import get_logger

log = get_logger(__name__)

# Pruning comes from context/scan_policy.py so this tool honours the same
# rules — and the same project .gitignore — as grep_search and workspace_tree.
# No include_ignored here on purpose: this tool summarises what the PROJECT
# is, and a summary of node_modules answers no question anyone asks.

_BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
    ".mp3", ".mp4", ".wav", ".avi", ".mov",
    ".zip", ".tar", ".gz", ".bz2", ".rar", ".7z",
    ".exe", ".dll", ".so", ".dylib", ".bin",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx",
    ".pyc", ".pyo", ".class", ".o", ".obj",
    ".woff", ".woff2", ".ttf", ".eot",
    ".sqlite", ".db", ".lock",
}

MAX_FILES = 500
BATCH_SIZE = 20
LINES_TO_READ = 25


class SummarizeWorkspaceTool(BaseTool):

    name = "summarize_workspace"

    description = (
        "Generate a COMPLETE markdown summary of ALL files in the workspace "
        "and SAVE it as a .md file in the output directory. Uses LLM to "
        "write accurate, contextual one-line descriptions for each file "
        "(reads actual code, not just filenames). This does everything in "
        "ONE call: scans files, reads content, generates descriptions via "
        "LLM, groups by directory, writes output. Use for 'list all files', "
        "'summarize workspace', 'purpose of each file'. After calling this, "
        "just call final_answer — no create_output needed."
    )

    def __init__(self, workspace: str, output_dir: str = None, llm=None):
        super().__init__(workspace)
        self._output_dir = output_dir or workspace
        self._llm = llm

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Root directory to summarize. Default: '.' (entire workspace)."
                },
                "output_filename": {
                    "type": "string",
                    "description": "Name of the output .md file. Default: 'file_purpose_summary.md'"
                },
                "title": {
                    "type": "string",
                    "description": "Title for the summary document. Default: 'Workspace File Summary'"
                }
            },
            "required": []
        }

    async def run(self, path=".", output_filename="file_purpose_summary.md", title="Workspace File Summary"):
        root = Path(self._resolve_path(path))

        if not root.exists():
            return {"error": f"Directory not found: {path}"}
        if not root.is_dir():
            return {"error": f"Not a directory: {path}"}

        project_root = Path(self.workspace)

        # ── Phase 1: Collect file info (Python, free) ───────────
        file_entries = []
        dir_files = defaultdict(list)
        total_size = 0

        policy = scan_policy.build(self.workspace)

        for dirpath, dirnames, filenames in os.walk(root):
            current = Path(dirpath)
            try:
                rel_dir = str(current.relative_to(project_root))
            except ValueError:
                rel_dir = str(current)

            _rel_posix = "" if rel_dir == "." else rel_dir.replace("\\", "/")
            dirnames[:] = [
                d for d in sorted(dirnames)
                if not policy.skip_dir(d, f"{_rel_posix}/{d}" if _rel_posix else d)
            ]

            dir_key = rel_dir.replace("\\", "/") if rel_dir != "." else "(root)"

            for filename in sorted(filenames):
                if filename.startswith(".") and filename not in {
                    ".gitignore", ".dockerignore", ".editorconfig", ".env.example",
                }:
                    continue

                file_path = current / filename
                try:
                    rel_path = str(file_path.relative_to(project_root)).replace("\\", "/")
                except ValueError:
                    rel_path = str(file_path)

                try:
                    size = file_path.stat().st_size
                except OSError:
                    size = 0

                total_size += size
                ext = file_path.suffix.lower()
                is_binary = ext in _BINARY_EXTENSIONS

                # Read first N lines for context
                snippet = ""
                if not is_binary and size > 0 and size < 300_000:
                    snippet = _read_first_lines(file_path, LINES_TO_READ)

                entry = {
                    "rel_path": rel_path,
                    "filename": filename,
                    "dir_key": dir_key,
                    "size": _human_size(size),
                    "is_binary": is_binary,
                    "snippet": snippet,
                    "purpose": "",
                }
                file_entries.append(entry)

                if len(file_entries) >= MAX_FILES:
                    break
            if len(file_entries) >= MAX_FILES:
                break

        total_files = len(file_entries)
        log.info(f"summarize_workspace: collected {total_files} files")

        # ── Phase 2: LLM describes files in batches ─────────────
        if self._llm:
            await self._describe_with_llm(file_entries)
        else:
            for entry in file_entries:
                entry["purpose"] = _fallback_purpose(entry)

        # ── Phase 3: Build markdown and write ───────────────────
        for entry in file_entries:
            dir_files[entry["dir_key"]].append(entry)

        md_lines = [
            f"# {title}",
            "",
            f"**Total files:** {total_files}  ",
            f"**Total size:** {_human_size(total_size)}  ",
            f"**Directories:** {len(dir_files)}",
            "",
            "---",
            "",
        ]

        for dir_key in sorted(dir_files.keys()):
            files = dir_files[dir_key]
            if dir_key == "(root)":
                md_lines.append("## Root Directory")
            else:
                md_lines.append(f"## {dir_key}/")
            md_lines.append("")
            for f in files:
                md_lines.append(f"- **{f['filename']}** ({f['size']}): {f['purpose']}")
            md_lines.append("")

        content = "\n".join(md_lines)

        # Write directly
        clean_name = output_filename.replace("..", "").lstrip("/\\")
        out_path = Path(self._output_dir) / clean_name
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(content, encoding="utf-8")

        return {
            "status": "created",
            "filename": clean_name,
            "path": str(out_path),
            "total_files": total_files,
            "total_dirs": len(dir_files),
            "total_size": _human_size(total_size),
            "content_length": len(content),
            "message": (
                f"Created {clean_name} with LLM-generated summaries for "
                f"{total_files} files across {len(dir_files)} directories "
                f"({_human_size(total_size)} total). File saved to: {out_path}"
            ),
        }

    async def _describe_with_llm(self, file_entries: list):
        """
        Send files to LLM in batches for description generation.

        Each batch: up to BATCH_SIZE files, each with their first 25 lines.
        The LLM returns one-line descriptions for each file.
        Total LLM calls: ceil(total_files / BATCH_SIZE)
        """
        # Separate files that need LLM vs obvious ones
        needs_llm = []
        for entry in file_entries:
            if entry["is_binary"]:
                entry["purpose"] = f"Binary file ({Path(entry['filename']).suffix})"
            elif not entry["snippet"]:
                entry["purpose"] = "Empty file (package marker)"
            else:
                obvious = _try_obvious_purpose(entry)
                if obvious:
                    entry["purpose"] = obvious
                else:
                    needs_llm.append(entry)

        if not needs_llm:
            return

        log.info(f"summarize_workspace: {len(needs_llm)} files need LLM descriptions, "
                 f"{len(file_entries) - len(needs_llm)} resolved without LLM")

        # Process in batches
        for batch_start in range(0, len(needs_llm), BATCH_SIZE):
            batch = needs_llm[batch_start:batch_start + BATCH_SIZE]
            batch_num = (batch_start // BATCH_SIZE) + 1
            total_batches = (len(needs_llm) + BATCH_SIZE - 1) // BATCH_SIZE

            log.info(f"summarize_workspace: LLM batch {batch_num}/{total_batches} ({len(batch)} files)")

            prompt_parts = []
            for i, entry in enumerate(batch):
                snippet = entry["snippet"][:800]
                prompt_parts.append(
                    f"FILE {i+1}: {entry['rel_path']}\n"
                    f"```\n{snippet}\n```"
                )

            prompt = (
                "For each file below, write ONE sentence describing its purpose. "
                "Be specific about what the code does — not generic descriptions. "
                "Focus on: what classes/functions it defines, what it handles, "
                "what other parts of the system use it.\n\n"
                "Format your response as:\n"
                "1: <description for FILE 1>\n"
                "2: <description for FILE 2>\n"
                "...\n\n"
                + "\n\n".join(prompt_parts)
            )

            try:
                response_text, usage = await self._llm.invoke(
                    [{"role": "user", "content": prompt}],
                    temperature=0.0,
                    max_tokens=2000,
                )

                descriptions = _parse_numbered_response(response_text, len(batch))

                for i, entry in enumerate(batch):
                    if i < len(descriptions) and descriptions[i]:
                        entry["purpose"] = descriptions[i]
                    else:
                        entry["purpose"] = _fallback_purpose(entry)

            except Exception as e:
                log.warning(f"LLM batch {batch_num} failed: {e}, using fallback")
                for entry in batch:
                    entry["purpose"] = _fallback_purpose(entry)


def _parse_numbered_response(text: str, expected_count: int) -> list:
    """
    Parse LLM response like:
      1: Authentication middleware for FastAPI routes.
      2: Database connection pool and query helpers.
      3: ...
    Returns list of description strings.
    """
    import re
    descriptions = [""] * expected_count

    for line in text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        match = re.match(r"^(\d+)\s*[:.)\-]\s*(.+)$", line)
        if match:
            idx = int(match.group(1)) - 1
            desc = match.group(2).strip()
            if 0 <= idx < expected_count:
                descriptions[idx] = desc

    return descriptions


def _try_obvious_purpose(entry: dict) -> str:
    """
    For files with obvious purpose, skip the LLM call.
    Returns description string or empty string if LLM is needed.
    """
    filename = entry["filename"]
    snippet = entry["snippet"]

    name_lower = filename.lower()
    if name_lower == ".gitignore":
        return "Git ignore rules — specifies files and directories excluded from version control"
    if name_lower == "dockerfile":
        for line in snippet.split("\n"):
            s = line.strip()
            if s.startswith("FROM "):
                return f"Docker container build configuration, based on {s[5:].strip()}"
        return "Docker container build configuration"
    if name_lower == "requirements.txt":
        deps = [l.strip() for l in snippet.split("\n") if l.strip() and not l.startswith("#")]
        return f"Python dependencies: {', '.join(deps[:5])}" + (" and more" if len(deps) > 5 else "")
    if name_lower == "package.json":
        return "Node.js package manifest (dependencies, scripts, metadata)"
    if name_lower == "package-lock.json":
        return "Locked dependency versions for reproducible npm installs"
    if name_lower in ("tsconfig.json", "tsconfig.tsbuildinfo"):
        return "TypeScript compiler configuration"

    ext = Path(filename).suffix.lower()

    if ext == ".json":
        stem = Path(filename).stem.lower()
        if "eslint" in stem:
            return "ESLint linting rules configuration"
        if "prettier" in stem:
            return "Prettier code formatting configuration"

    # __init__.py with a docstring
    if filename == "__init__.py" and snippet.strip():
        for line in snippet.split("\n"):
            s = line.strip()
            if s.startswith('"""') or s.startswith("'''"):
                content = s[3:].rstrip('"""').rstrip("'''").strip()
                if content and len(content) > 5:
                    return f"Package init: {content}"
            if s.startswith("#"):
                comment = s[1:].strip()
                if comment and len(comment) > 5:
                    return f"Package init: {comment}"
        return "Python package initialization"

    return ""


def _fallback_purpose(entry: dict) -> str:
    """Last resort when LLM is unavailable."""
    filename = entry["filename"]
    snippet = entry["snippet"]
    ext = Path(filename).suffix.lower()

    if not snippet:
        return "Empty file"

    if ext == ".py":
        for line in snippet.split("\n"):
            s = line.strip()
            if s.startswith('"""') or s.startswith("'''"):
                content = s[3:].rstrip('"""').rstrip("'''").strip()
                if content and len(content) > 5 and "/" not in content:
                    return content[:150]
            if s.startswith("#") and not s.startswith("#!"):
                comment = s[1:].strip()
                if comment and len(comment) > 5:
                    return comment[:150]
            if s.startswith("class "):
                name = s.split("(")[0].split(":")[0].replace("class ", "")
                return f"Defines class {name}"
        return f"Python module: {filename.replace('.py', '')}"

    if ext == ".md":
        for line in snippet.split("\n"):
            s = line.strip()
            if s.startswith("#"):
                return s.lstrip("# ")[:150]
        return "Markdown document"

    name = Path(filename).stem
    return f"File: {name}"


def _read_first_lines(file_path: Path, num_lines: int) -> str:
    try:
        lines = []
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            for _ in range(num_lines):
                line = f.readline()
                if not line:
                    break
                lines.append(line.rstrip())
        return "\n".join(lines)
    except Exception:
        return ""


def _human_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
