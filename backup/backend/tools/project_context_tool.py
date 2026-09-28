"""
Project Context Tool

Gives the agent instant understanding of any workspace — language,
framework, build commands, directory structure, and conventions —
without reading every file. This is the "Gather Context" step.

The tool calls the project scanner (context/project_scanner.py)
which reads only high-signal entry-point files (package.json,
Cargo.toml, go.mod, README, etc.) and maps directory names to
architectural roles. Results are cached per workspace.

This is how Claude Code understands projects in seconds:
  1. Read manifest → know the language + deps + scripts
  2. Map directories → know the architecture
  3. Check README / AI instructions → know conventions
"""

from .base_tool import BaseTool
from context.project_scanner import scan_project


class ProjectContextTool(BaseTool):

    name = "project_context"

    description = (
        "Get instant understanding of the workspace: language, framework, "
        "build/test/run commands, directory structure roles, key dependencies, "
        "and project conventions. Call this FIRST before exploring files. "
        "Works on any language (Python, JS, Go, Rust, Java, Ruby, etc.) "
        "by reading manifest files (package.json, Cargo.toml, go.mod...). "
        "Results are cached — calling twice is free."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": (
                        "Directory to scan. Default: '.' (current workspace root). "
                        "Use this to scan a subdirectory or external path."
                    )
                }
            },
            "required": []
        }

    async def run(self, path="."):
        scan_path = self._resolve_path(path)
        ctx = scan_project(scan_path)
        return ctx.to_dict()
