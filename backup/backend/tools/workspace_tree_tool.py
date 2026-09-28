"""
Workspace Tree Tool

Returns a COMPLETE recursive listing of ALL files in the workspace
in a single call. This replaces the pattern of calling list_directory
10+ times to discover nested files.

Output is compact: one line per file with relative path and size.
Directories are shown as tree structure markers, not separate entries.

This is the Claude Code approach: Glob/tree the entire workspace ONCE,
then use the full file list to decide what to read. No more wasting
steps on repeated list_directory calls.
"""

import os
from pathlib import Path

from context import scan_policy
from context.scan_policy import INCLUDE_IGNORED_DESCRIPTION

from .base_tool import BaseTool

# Which directories to prune is decided per call by context/scan_policy.py —
# from the project's own ignore files, overridable by include_ignored or by
# aiming `path` at a directory. A constant here is how the tree could show a
# folder that grep had permanently hidden.

_BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
    ".mp3", ".mp4", ".wav", ".avi", ".mov",
    ".zip", ".tar", ".gz", ".bz2", ".rar", ".7z",
    ".exe", ".dll", ".so", ".dylib", ".bin",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx",
    ".pyc", ".pyo", ".class", ".o", ".obj",
    ".woff", ".woff2", ".ttf", ".eot",
    ".sqlite", ".db",
    ".lock",
}

MAX_FILES = 500


class WorkspaceTreeTool(BaseTool):

    name = "workspace_tree"

    description = (
        "Get a COMPLETE recursive listing of ALL files in the workspace "
        "(or a subdirectory) in one call. Returns every file path with "
        "its size. Use this FIRST for workspace analysis tasks instead "
        "of calling list_directory multiple times. Much more efficient "
        "than listing directories one by one. Dependencies, build output and "
        "caches are pruned by default; set include_ignored=true or point "
        "`path` at one to see inside it."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "Root directory to scan. Default: '.' (entire workspace). "
                        "Examples: '.', 'src', 'agents'"
                    )
                },
                "include_summary": {
                    "type": "boolean",
                    "description": (
                        "If true, include the first non-empty line of each "
                        "text file as a preview hint. Helps understand file "
                        "purpose without reading the full file. Default: true"
                    )
                },
                "include_ignored": {
                    "type": "boolean",
                    "description": INCLUDE_IGNORED_DESCRIPTION,
                }
            },
            "required": []
        }

    async def run(self, path=".", include_summary=True, include_ignored=False):
        root = Path(self._resolve_path(path))

        if not root.exists():
            return {"error": f"Directory not found: {path}"}
        if not root.is_dir():
            return {"error": f"Not a directory: {path}"}

        project_root = Path(self.workspace)
        policy = scan_policy.build(
            self.workspace,
            include_ignored=bool(include_ignored),
            path=path,
        )
        files = []
        dirs_seen = set()
        total_size = 0

        for dirpath, dirnames, filenames in os.walk(root):
            current = Path(dirpath)
            try:
                rel_dir = str(current.relative_to(project_root))
            except ValueError:
                rel_dir = str(current)

            # Pruned by relative PATH so an explicitly targeted directory is
            # reachable; by name alone, `path="node_modules/express"` would
            # still be pruned at its own first level.
            _rel_posix = "" if rel_dir == "." else rel_dir.replace("\\", "/")
            dirnames[:] = [
                d for d in sorted(dirnames)
                if not policy.skip_dir(d, f"{_rel_posix}/{d}" if _rel_posix else d)
            ]

            if rel_dir != ".":
                dirs_seen.add(rel_dir)

            for filename in sorted(filenames):
                if filename.startswith(".") and filename not in {
                    ".gitignore", ".dockerignore", ".editorconfig",
                    ".env.example",
                }:
                    continue

                file_path = current / filename
                try:
                    rel_path = str(file_path.relative_to(project_root))
                except ValueError:
                    rel_path = str(file_path)

                try:
                    size = file_path.stat().st_size
                except OSError:
                    size = 0

                total_size += size
                ext = file_path.suffix.lower()
                is_binary = ext in _BINARY_EXTENSIONS

                entry = {
                    "path": rel_path.replace("\\", "/"),
                    "size": _human_size(size),
                    "size_bytes": size,
                }

                if include_summary and not is_binary and size < 100_000:
                    hint = _get_file_hint(file_path)
                    if hint:
                        entry["hint"] = hint

                files.append(entry)

                if len(files) >= MAX_FILES:
                    return {
                        "path": path,
                        "total_files": len(files),
                        "total_dirs": len(dirs_seen),
                        "total_size": _human_size(total_size),
                        "scope": policy.describe(),
                        "truncated": True,
                        "message": f"Showing first {MAX_FILES} files. Use a subdirectory path to narrow the scan.",
                        "files": files,
                    }

        return {
            "path": path,
            "total_files": len(files),
            "total_dirs": len(dirs_seen),
            "total_size": _human_size(total_size),
            "scope": policy.describe(),
            "truncated": False,
            "files": files,
        }


def _get_file_hint(file_path: Path) -> str:
    """
    Extract a one-line hint about the file's purpose.

    Strategy (in priority order):
    1. Python/JS docstring or module-level comment
    2. First non-empty, non-import line
    3. Empty string if nothing useful found
    """
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            lines = []
            for _ in range(30):
                line = f.readline()
                if not line:
                    break
                lines.append(line.rstrip())
    except Exception:
        return ""

    if not lines:
        return ""

    ext = file_path.suffix.lower()

    # Python: look for module docstring or top comment
    if ext == ".py":
        in_docstring = False
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith('"""') or stripped.startswith("'''"):
                if in_docstring:
                    break
                content = stripped[3:]
                if content.endswith('"""') or content.endswith("'''"):
                    return content[:-3].strip()[:120]
                if content.strip():
                    return content.strip()[:120]
                in_docstring = True
                continue
            if in_docstring:
                if stripped:
                    return stripped[:120]
            if stripped.startswith("#") and not stripped.startswith("#!"):
                return stripped[1:].strip()[:120]
            if stripped.startswith(("import ", "from ")):
                continue
            if stripped.startswith(("class ", "def ")):
                return stripped[:120]
            break

    # JavaScript/TypeScript: look for JSDoc or top comment
    elif ext in (".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"):
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("//"):
                return stripped[2:].strip()[:120]
            if stripped.startswith("/**") or stripped.startswith("/*"):
                content = stripped.lstrip("/* ")
                if content:
                    return content.rstrip("*/").strip()[:120]
                continue
            if stripped.startswith("* "):
                return stripped[2:].strip()[:120]
            if stripped.startswith(("import ", "export ", "'use ", '"use ')):
                continue
            break

    # YAML/TOML/INI: first comment
    elif ext in (".yaml", ".yml", ".toml", ".ini", ".cfg"):
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("#"):
                return stripped[1:].strip()[:120]
            break

    # Markdown: first heading
    elif ext == ".md":
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("#"):
                return stripped.lstrip("# ").strip()[:120]
            return stripped[:120]

    # Dockerfile
    elif file_path.name in ("Dockerfile", "docker-compose.yml", "docker-compose.yaml"):
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("#"):
                return stripped[1:].strip()[:120]
            if stripped.startswith("FROM "):
                return f"Docker image based on {stripped[5:].strip()}"[:120]
            break

    # Fallback: first non-empty line
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith(("#!", "<?xml")):
            return stripped[:120]

    return ""


def _human_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
