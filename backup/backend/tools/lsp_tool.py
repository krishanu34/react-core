"""
LSP Tool — Code Intelligence

Provides language-aware code analysis without running a full LSP server.
Uses each language's built-in CLI tools for:
  - Type checking / diagnostics
  - Find definition (grep-enhanced with language awareness)
  - Find references
  - List symbols in a file

Supported languages and their tools:
  Python:     pyflakes, mypy, python -m py_compile
  TypeScript: tsc --noEmit
  Go:         go vet, go build
  Rust:       cargo check
  Java:       javac -Xlint
  C#:         dotnet build --no-restore
  C/C++:      gcc -fsyntax-only
"""

import asyncio
import re
from pathlib import Path

from .base_tool import BaseTool
from utils.logger import get_logger

log = get_logger(__name__)

# Language -> type check command
_TYPE_CHECK_COMMANDS = {
    "Python": ["python -m py_compile {file}", "python -m pyflakes {file}"],
    "TypeScript": ["npx tsc --noEmit --pretty"],
    "JavaScript": ["npx eslint {file} --no-eslintrc --rule '{}'"],
    "Go": ["go vet ./..."],
    "Rust": ["cargo check 2>&1"],
    "Java": ["javac -Xlint -d /dev/null {file}"],
    "C#": ["dotnet build --no-restore --nologo -v q 2>&1"],
    "C/C++": ["gcc -fsyntax-only -Wall {file} 2>&1"],
}

# Language -> symbol definition patterns
_DEFINITION_PATTERNS = {
    "Python": [
        r"^\s*(def|class|async\s+def)\s+{symbol}",
        r"^\s*{symbol}\s*=",
    ],
    "TypeScript": [
        r"^\s*(export\s+)?(function|class|interface|type|const|let|var|enum)\s+{symbol}",
    ],
    "JavaScript": [
        r"^\s*(export\s+)?(function|class|const|let|var)\s+{symbol}",
    ],
    "Go": [
        r"^\s*(func|type|var|const)\s+{symbol}",
        r"^\s*func\s+\([^)]+\)\s+{symbol}",
    ],
    "Rust": [
        r"^\s*(pub\s+)?(fn|struct|enum|trait|type|const|static|mod)\s+{symbol}",
    ],
    "Java": [
        r"^\s*(public|private|protected)?\s*(static\s+)?(class|interface|enum|void|int|String|boolean)\s+{symbol}",
    ],
    "C#": [
        r"^\s*(public|private|protected|internal)?\s*(static\s+)?(class|struct|interface|enum|void|int|string|bool|async)\s+{symbol}",
    ],
}


class LspTool(BaseTool):

    name = "lsp"

    description = (
        "Code intelligence: type checking, find definitions, find references, "
        "and list symbols. Uses each language's CLI tools (pyflakes, tsc, go vet, "
        "cargo check, etc.). Operations: 'diagnostics' (type errors/warnings), "
        "'definition' (find where a symbol is defined), 'references' (find all "
        "uses of a symbol), 'symbols' (list functions/classes in a file)."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "description": (
                        "Operation: 'diagnostics' (type check a file or project), "
                        "'definition' (find where a symbol is defined), "
                        "'references' (find all uses of a symbol), "
                        "'symbols' (list all symbols in a file)"
                    )
                },
                "file": {
                    "type": "string",
                    "description": "File path for diagnostics/symbols. Optional for project-wide checks."
                },
                "symbol": {
                    "type": "string",
                    "description": "Symbol name for definition/references lookups."
                },
                "language": {
                    "type": "string",
                    "description": "Language (auto-detected if not specified). E.g., 'Python', 'TypeScript', 'Go'"
                }
            },
            "required": ["operation"]
        }

    async def run(self, operation, file=None, symbol=None, language=None):
        # Auto-detect language if not specified
        if not language:
            language = self._detect_language(file)

        if operation == "diagnostics":
            return await self._diagnostics(file, language)
        elif operation == "definition":
            if not symbol:
                return {"error": "Provide 'symbol' name for definition lookup"}
            return await self._find_definition(symbol, language, file)
        elif operation == "references":
            if not symbol:
                return {"error": "Provide 'symbol' name for references lookup"}
            return await self._find_references(symbol, language)
        elif operation == "symbols":
            if not file:
                return {"error": "Provide 'file' path for symbol listing"}
            return await self._list_symbols(file, language)
        else:
            return {"error": f"Unknown operation '{operation}'. Use: diagnostics, definition, references, symbols"}

    def _detect_language(self, file=None):
        ext_map = {
            ".py": "Python", ".pyw": "Python",
            ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
            ".ts": "TypeScript", ".tsx": "TypeScript",
            ".go": "Go",
            ".rs": "Rust",
            ".java": "Java",
            ".cs": "C#",
            ".c": "C/C++", ".cpp": "C/C++", ".h": "C/C++",
            ".rb": "Ruby",
            ".php": "PHP",
            ".swift": "Swift",
            ".kt": "Kotlin",
            ".scala": "Scala",
            ".ex": "Elixir", ".exs": "Elixir",
            ".hs": "Haskell",
        }
        if file:
            ext = Path(file).suffix.lower()
            return ext_map.get(ext, "Unknown")

        # Try project_context
        from context.project_scanner import scan_project
        ctx = scan_project(self.workspace)
        return ctx.primary_language or "Unknown"

    async def _diagnostics(self, file, language):
        commands = _TYPE_CHECK_COMMANDS.get(language, [])
        if not commands:
            return {"error": f"No type checker configured for {language}"}

        results = []
        for cmd_template in commands:
            cmd = cmd_template.replace("{file}", file or ".")
            output = await self._run_cmd(cmd)
            if output.strip():
                results.append({"command": cmd, "output": output[:3000]})

        if not results:
            return {"language": language, "diagnostics": [], "message": "No errors or warnings found"}

        return {
            "language": language,
            "file": file,
            "diagnostics": results,
        }

    async def _find_definition(self, symbol, language, file=None):
        patterns = _DEFINITION_PATTERNS.get(language, [])

        # Build regex patterns for the symbol
        search_patterns = []
        for p in patterns:
            search_patterns.append(p.format(symbol=re.escape(symbol)))

        # Also add a generic fallback
        search_patterns.append(rf"\b{re.escape(symbol)}\s*[=:(]")

        # Search through project files
        ext_map = {
            "Python": "*.py", "TypeScript": "*.ts", "JavaScript": "*.js",
            "Go": "*.go", "Rust": "*.rs", "Java": "*.java", "C#": "*.cs",
            "C/C++": "*.c", "Ruby": "*.rb", "PHP": "*.php",
        }
        file_glob = ext_map.get(language, "*")

        results = []
        root = Path(self.workspace)
        for source_file in root.rglob(file_glob):
            if any(part.startswith(".") or part in {"node_modules", "__pycache__", ".venv", "venv"}
                   for part in source_file.parts):
                continue
            try:
                content = source_file.read_text(encoding="utf-8", errors="replace")
                for i, line in enumerate(content.splitlines(), 1):
                    for pattern in search_patterns:
                        if re.search(pattern, line):
                            rel = str(source_file.relative_to(root))
                            results.append({
                                "file": rel, "line": i,
                                "content": line.strip()[:200],
                                "type": "definition",
                            })
                            break
            except OSError:
                continue

            if len(results) >= 20:
                break

        return {
            "symbol": symbol,
            "language": language,
            "definitions": results,
            "total": len(results),
        }

    async def _find_references(self, symbol, language):
        ext_map = {
            "Python": "*.py", "TypeScript": "*.ts", "JavaScript": "*.js",
            "Go": "*.go", "Rust": "*.rs", "Java": "*.java", "C#": "*.cs",
        }
        file_glob = ext_map.get(language, "*")

        results = []
        root = Path(self.workspace)
        pattern = re.compile(rf"\b{re.escape(symbol)}\b")

        for source_file in root.rglob(file_glob):
            if any(part.startswith(".") or part in {"node_modules", "__pycache__", ".venv", "venv"}
                   for part in source_file.parts):
                continue
            try:
                content = source_file.read_text(encoding="utf-8", errors="replace")
                for i, line in enumerate(content.splitlines(), 1):
                    if pattern.search(line):
                        rel = str(source_file.relative_to(root))
                        results.append({
                            "file": rel, "line": i,
                            "content": line.strip()[:200],
                        })
            except OSError:
                continue

            if len(results) >= 50:
                break

        return {
            "symbol": symbol,
            "language": language,
            "references": results,
            "total": len(results),
        }

    async def _list_symbols(self, file, language):
        file_path = Path(self._resolve_path(file))
        if not file_path.exists():
            return {"error": f"File not found: {file}"}

        try:
            content = file_path.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return {"error": f"Failed to read: {e}"}

        symbols = []
        lines = content.splitlines()

        # Language-specific symbol extraction
        if language == "Python":
            for i, line in enumerate(lines, 1):
                m = re.match(r"^(class|def|async\s+def)\s+(\w+)", line)
                if m:
                    symbols.append({"name": m.group(2), "type": m.group(1).strip(), "line": i})
        elif language in ("TypeScript", "JavaScript"):
            for i, line in enumerate(lines, 1):
                m = re.match(r"^\s*(export\s+)?(function|class|interface|type|const|let|var|enum)\s+(\w+)", line)
                if m:
                    symbols.append({"name": m.group(3), "type": m.group(2), "line": i})
        elif language == "Go":
            for i, line in enumerate(lines, 1):
                m = re.match(r"^(func|type|var|const)\s+(\w+)", line)
                if m:
                    symbols.append({"name": m.group(2), "type": m.group(1), "line": i})
        elif language == "Rust":
            for i, line in enumerate(lines, 1):
                m = re.match(r"^\s*(pub\s+)?(fn|struct|enum|trait|impl|mod|const|static|type)\s+(\w+)", line)
                if m:
                    symbols.append({"name": m.group(3), "type": m.group(2), "line": i})
        elif language in ("Java", "C#"):
            for i, line in enumerate(lines, 1):
                m = re.match(r"^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum|void|int|String|bool|var)\s+(\w+)", line)
                if m:
                    symbols.append({"name": m.group(1), "type": "symbol", "line": i})
        else:
            # Generic: look for function/class patterns
            for i, line in enumerate(lines, 1):
                m = re.match(r"^\s*(?:function|class|def|fn|func|sub|proc|type)\s+(\w+)", line)
                if m:
                    symbols.append({"name": m.group(1), "type": "symbol", "line": i})

        return {
            "file": file,
            "language": language,
            "symbols": symbols,
            "total": len(symbols),
        }

    async def _run_cmd(self, cmd):
        try:
            process = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=self.workspace,
            )
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=30)
            return stdout.decode("utf-8", errors="replace").strip()
        except (asyncio.TimeoutError, Exception) as e:
            return f"Error: {e}"
