"""
Grep Search Tool — Claude Code Grep parity.

Primary navigation tool for large codebases: finds exactly which files matter
WITHOUT reading them all into context. On brownfield work this tool IS the
product — greenfield writes files, brownfield has to find them first.

Claude Code's Grep contract, reproduced here because each piece earns its keep
on legacy code:

  output_mode      content (default) | files_with_matches | count.
                   The SURVEY modes are the brownfield workhorse: "which 40
                   files mention this?" answers with paths and counts, and the
                   model drills into 2-3 of them — instead of being handed 50
                   content lines from whichever file happened to sort first.
  context          -C: lines shown around each match. Relevance is judged
                   INLINE, without a follow-up read_file per candidate — which
                   is both fewer steps and fewer wrong picks.
  head_limit/offset  bounded, pageable results instead of a hard 50.
  multiline        patterns that span lines (a signature wrapped mid-argument).
  include_ignored  reach into dependencies and build output when the question
                   is about them. Which directories are skipped is decided
                   per call by context/scan_policy.py — from the PROJECT's own
                   ignore files, overridable by this flag or simply by aiming
                   file_pattern at the directory. A frozen skip-list made
                   "what does the installed copy of this library actually do?"
                   unanswerable, and the agent guessed instead of looking.

Engine: ripgrep when installed (same engine Claude Code uses), pure-Python
fallback with identical parameters otherwise — a host without rg gets the same
contract, just slower.

Two caps, deliberately separate (conflating them was a live bug — `-m` IS
`--max-count`, so passing both made the per-file cap 50 and one noisy
generated file could fill the entire result set while the file the user
actually cared about never appeared):

  MAX_PER_FILE   matches contributed by ONE file (content mode)
  head_limit     matches returned in total
"""

import asyncio
import json
import os
import re
import shutil
from pathlib import Path

from context import scan_policy
from context.scan_policy import INCLUDE_IGNORED_DESCRIPTION

from .base_tool import BaseTool
from .sensitive_guard import redact_sensitive_content

# What to skip is no longer a constant here — it is decided per call by
# context/scan_policy.py from the project's own ignore files, and overridden
# when the model targets a directory or sets include_ignored. See that module
# for why a frozen list made dependency questions unanswerable.

MAX_PER_FILE     = 5          # content-mode matches one file may contribute
DEFAULT_LIMIT    = 50         # total matches when head_limit not given
HARD_LIMIT       = 200        # ceiling on head_limit
MAX_CONTEXT      = 10         # ceiling on context lines per side
MAX_FILE_SIZE    = 1_000_000  # skip files larger than 1MB (fallback engine)
_RG_TIMEOUT      = 15.0

_VALID_MODES = ("content", "files_with_matches", "count")

def _find_rg():
    """Locate a ripgrep binary: RIPGREP_PATH env var, then PATH, then the
    copies that ship inside VS Code installs.

    The VS Code probe matters in practice: most Windows/mac hosts have never
    installed rg themselves but DO have VS Code, which bundles it — and the
    difference between engines on a big brownfield repo is 100ms vs several
    seconds per search, across the many searches one question takes.
    """
    explicit = os.getenv("RIPGREP_PATH")
    if explicit and os.path.isfile(explicit):
        return explicit

    on_path = shutil.which("rg")
    if on_path:
        return on_path

    import glob as _glob
    exe = "rg.exe" if os.name == "nt" else "rg"
    candidates = []
    if os.name == "nt":
        for base in (os.environ.get("ProgramFiles", r"C:\Program Files"),
                     os.environ.get("LOCALAPPDATA", "")):
            if base:
                candidates.append(os.path.join(
                    base, "Microsoft VS Code", "**", "@vscode", "ripgrep*",
                    "bin", "**", exe))
                candidates.append(os.path.join(
                    base, "Programs", "Microsoft VS Code", "**", "@vscode",
                    "ripgrep*", "bin", "**", exe))
    else:
        candidates.append(os.path.join(
            "/usr/share/code", "**", "@vscode", "ripgrep*", "bin", "**", exe))
        candidates.append(os.path.join(
            "/Applications/Visual Studio Code.app", "**", "@vscode",
            "ripgrep*", "bin", "**", exe))

    for pattern in candidates:
        hits = _glob.glob(pattern, recursive=True)
        if hits:
            return hits[0]
    return None


# Detect ripgrep once at import time
_RG = _find_rg()


class GrepSearchTool(BaseTool):

    name = "grep_search"

    description = (
        "Search a text pattern or regex across the project. THE tool for "
        "navigating existing code — use it BEFORE reading any file. "
        "Brownfield recipe: (1) survey with output_mode='files_with_matches' "
        "to see WHICH files mention the symbol, (2) drill into the right ones "
        "with output_mode='content' and context=3 to judge each match inline, "
        "(3) read_file the exact region. Returns matching lines with file "
        "paths and line numbers; context shows the surrounding lines so you "
        "rarely need a follow-up read to decide relevance. "
        "Dependencies and build output are skipped by default — set "
        "include_ignored=true, or point file_pattern at the directory, when "
        "the question is about third-party or generated code."
    )

    def parameters(self):
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Text or regex pattern. Examples: 'def authenticate', "
                        "'class.*Controller', 'import jwt', 'TODO|FIXME'"
                    )
                },
                "file_pattern": {
                    "type": "string",
                    "description": (
                        "Optional glob filter. Examples: '*.py', '*.ts', "
                        "'src/**/*.js'. Default: all text files."
                    )
                },
                "output_mode": {
                    "type": "string",
                    "enum": ["content", "files_with_matches", "count"],
                    "description": (
                        "'content' (default): matching lines. "
                        "'files_with_matches': just the file paths — use FIRST "
                        "when a symbol may be widespread, to see the "
                        "distribution before reading anything. "
                        "'count': per-file match counts — shows the hot spots."
                    )
                },
                "context": {
                    "type": "integer",
                    "description": (
                        "Lines of context around each match (like grep -C). "
                        "Use 2-3 when judging relevance: the surrounding lines "
                        "usually answer 'is this the real definition or just a "
                        "mention?' without reading the file. Max 10. Default 0."
                    )
                },
                "case_sensitive": {
                    "type": "boolean",
                    "description": "Case-sensitive search. Default: true"
                },
                "multiline": {
                    "type": "boolean",
                    "description": (
                        "Let the pattern span line boundaries ('.' matches "
                        "newlines). For signatures/calls wrapped across lines. "
                        "Default: false."
                    )
                },
                "head_limit": {
                    "type": "integer",
                    "description": f"Max results to return (default {DEFAULT_LIMIT}, max {HARD_LIMIT})."
                },
                "offset": {
                    "type": "integer",
                    "description": "Skip this many results first — pages through a large result set."
                },
                "include_ignored": {
                    "type": "boolean",
                    "description": INCLUDE_IGNORED_DESCRIPTION,
                },
            },
            "required": ["query"]
        }

    async def run(self, query, file_pattern=None, output_mode="content",
                  context=0, case_sensitive=True, multiline=False,
                  head_limit=None, offset=0, include_ignored=False):
        root = Path(self.workspace)

        # Which directories this call may walk. Built from the project's own
        # ignore files, then overridden by whatever the model aimed at: a
        # file_pattern rooted inside node_modules unlocks node_modules without
        # opening up the rest of the tree.
        policy = scan_policy.build(
            self.workspace,
            include_ignored=bool(include_ignored),
            file_pattern=file_pattern,
        )

        # Normalise arguments defensively — these come from a model.
        if output_mode not in _VALID_MODES:
            output_mode = "content"
        try:
            context = max(0, min(int(context or 0), MAX_CONTEXT))
        except (TypeError, ValueError):
            context = 0
        try:
            limit = max(1, min(int(head_limit or DEFAULT_LIMIT), HARD_LIMIT))
        except (TypeError, ValueError):
            limit = DEFAULT_LIMIT
        try:
            offset = max(0, int(offset or 0))
        except (TypeError, ValueError):
            offset = 0

        if _RG:
            result = await _search_with_ripgrep(
                root, query, file_pattern, case_sensitive,
                output_mode, context, multiline, limit, offset, policy,
            )
            if result is not None:
                result["scope"] = policy.describe()
                return result
        # rg missing, timed out, or errored — same contract, Python engine.
        result = _search_with_python(
            root, query, file_pattern, case_sensitive,
            output_mode, context, multiline, limit, offset, policy,
        )
        result["scope"] = policy.describe()
        return result


# ── ripgrep engine ───────────────────────────────────────────────────────────

def _rg_base_cmd(query, file_pattern, case_sensitive, multiline, policy):
    cmd = [_RG, "--json", "--no-messages"]
    if not case_sensitive:
        cmd.append("--ignore-case")
    if multiline:
        cmd += ["--multiline", "--multiline-dotall"]
    # Directory exclusions come from the policy (empty when the caller opted
    # in or targeted something), and --no-ignore is added in the same case:
    # without it rg would still honour the project's .gitignore and the
    # opt-in would silently do nothing.
    cmd += list(policy.rg_extra_args())
    for glob in policy.rg_exclude_globs():
        cmd += ["--glob", glob]
    # Binary/generated FILES stay excluded in every mode — nobody grepping a
    # dependency wants .pyc or sourcemap hits.
    for ext in scan_policy.DEFAULT_NOISE_EXTENSIONS:
        cmd += ["--glob", f"!*{ext}"]
    if file_pattern:
        cmd += ["--glob", file_pattern]
    return cmd


async def _run_rg(cmd, cwd=None):
    """Run rg, returning stdout text or None on timeout/absence. rg exits 1
    on no-matches — that is a result, not an error.

    `cwd` is the workspace: rg is always run FROM the project root and told to
    search ".", because a --glob containing a slash is anchored to the search
    path as given. Passing an absolute search path meant a pattern like
    ``node_modules/express/**`` was compared against the full drive path and
    matched nothing — targeting silently returned zero results on the ripgrep
    engine while working fine on the Python one.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=_RG_TIMEOUT)
    except (asyncio.TimeoutError, FileNotFoundError, OSError):
        return None
    if proc.returncode not in (0, 1):
        return None  # bad pattern etc. — let the Python engine report it
    return stdout.decode("utf-8", errors="replace")


async def _search_with_ripgrep(root, query, file_pattern, case_sensitive,
                               output_mode, context, multiline, limit, offset,
                               policy):
    """Returns a result dict, or None when rg couldn't run (caller falls back)."""

    # Survey modes use rg's own aggregation — no per-line JSON to parse, and
    # no way for one file's volume to distort the picture.
    if output_mode in ("files_with_matches", "count"):
        cmd = _rg_base_cmd(query, file_pattern, case_sensitive, multiline, policy)
        cmd.remove("--json")
        cmd.append("--files-with-matches" if output_mode == "files_with_matches"
                   else "--count-matches")
        cmd += ["--", query, "."]
        out = await _run_rg(cmd, cwd=str(root))
        if out is None:
            return None
        return _render_survey(out, root, query, output_mode, limit, offset, "ripgrep")

    # Content mode. --max-count is the PER-FILE cap; the total cap is applied
    # while parsing. (These were conflated before: `-m` is an alias of
    # --max-count, so `--max-count 5 -m 50` silently meant 50 per file and one
    # noisy file could occupy the whole result set.)
    cmd = _rg_base_cmd(query, file_pattern, case_sensitive, multiline, policy)
    cmd += ["--max-count", str(MAX_PER_FILE)]
    if context:
        cmd += ["--context", str(context)]
    cmd += ["--", query, "."]

    out = await _run_rg(cmd, cwd=str(root))
    if out is None:
        return None

    # rg --json emits, per file: begin → (context|match)* → end. AFTER-context
    # lines arrive after their match event, so snippets can only be rendered
    # once the file's events are complete — rendering at match time silently
    # drops the trailing context and the model judges relevance on half a
    # window. Collect per file, render at "end".
    matches = []            # every match, pre-offset/limit
    current_file = None
    file_lines = {}         # line_number -> text (context AND match lines)
    file_matches = []       # (line_number, text) in this file

    def _rel(p):
        return _relativise(p, root)

    def _flush():
        for line_num, text in file_matches:
            entry = {
                "file": current_file,
                "line": line_num,
                "content": redact_sensitive_content(text[:300]),
            }
            if context:
                rows = []
                for num in range(line_num - context, line_num + context + 1):
                    if num == line_num:
                        rows.append(f"{num:>5}: {text[:200]}")
                    elif num in file_lines:
                        rows.append(f"{num:>5}- {file_lines[num][:200]}")
                entry["snippet"] = redact_sensitive_content("\n".join(rows))
            matches.append(entry)

    for line in out.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        typ = obj.get("type")
        data = obj.get("data", {})
        if typ == "begin":
            current_file = _rel(data.get("path", {}).get("text", ""))
            file_lines, file_matches = {}, []
        elif typ == "context":
            file_lines[data.get("line_number", 0)] = (
                data.get("lines", {}).get("text", "").rstrip("\n"))
        elif typ == "match":
            line_num = data.get("line_number", 0)
            text = data.get("lines", {}).get("text", "").rstrip("\n")
            file_lines[line_num] = text
            file_matches.append((line_num, text))
        elif typ == "end":
            _flush()

    return _render_content(matches, query, limit, offset, "ripgrep")


# ── Python engine (identical contract) ───────────────────────────────────────

def _compile(query, case_sensitive, multiline):
    flags = 0 if case_sensitive else re.IGNORECASE
    if multiline:
        flags |= re.MULTILINE | re.DOTALL
    try:
        return re.compile(query, flags)
    except re.error:
        return re.compile(re.escape(query), flags)


def _search_with_python(root, query, file_pattern, case_sensitive,
                        output_mode, context, multiline, limit, offset, policy):
    pattern = _compile(query, case_sensitive, multiline)

    per_file_counts = {}    # rel_path -> match count (survey modes)
    matches = []            # content mode
    files_searched = 0

    for file_path in _walk_files(root, file_pattern, policy):
        files_searched += 1
        try:
            if file_path.stat().st_size > MAX_FILE_SIZE:
                continue
        except OSError:
            continue

        rel = str(file_path.relative_to(root)).replace("\\", "/")

        if multiline:
            file_matches, count = _search_file_multiline(
                file_path, pattern, rel, context)
        else:
            file_matches, count = _search_file_lines(
                file_path, pattern, rel, context)

        if count:
            per_file_counts[rel] = count
            matches.extend(file_matches[:MAX_PER_FILE])

        # Survey modes must keep counting even past the content cap — the
        # distribution is the answer. Content mode can stop early.
        if output_mode == "content" and len(matches) >= offset + limit + 1:
            break

    if output_mode in ("files_with_matches", "count"):
        lines = (f"{path}:{count}" for path, count in per_file_counts.items()) \
            if output_mode == "count" else iter(per_file_counts)
        return _render_survey("\n".join(lines), root, query, output_mode,
                              limit, offset, "python",
                              files_searched=files_searched)

    result = _render_content(matches, query, limit, offset, "python")
    result["files_searched"] = files_searched
    return result


def _search_file_lines(file_path, pattern, rel, context):
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except (PermissionError, OSError):
        return [], 0

    out, count = [], 0
    for i, line in enumerate(lines):
        if not pattern.search(line):
            continue
        count += 1
        if len(out) >= MAX_PER_FILE:
            continue  # keep counting for survey modes, stop collecting
        entry = {
            "file": rel,
            "line": i + 1,
            "content": redact_sensitive_content(line.rstrip()[:300]),
        }
        if context:
            lo, hi = max(0, i - context), min(len(lines), i + context + 1)
            rows = []
            for j in range(lo, hi):
                mark = ":" if j == i else "-"
                rows.append(f"{j + 1:>5}{mark} {lines[j].rstrip()[:200]}")
            entry["snippet"] = redact_sensitive_content("\n".join(rows))
        out.append(entry)
    return out, count


def _search_file_multiline(file_path, pattern, rel, context):
    """Multiline: match against the whole text, then map back to line numbers."""
    try:
        text = file_path.read_text(encoding="utf-8", errors="replace")
    except (PermissionError, OSError):
        return [], 0

    lines = text.splitlines()
    out, count = [], 0
    for m in pattern.finditer(text):
        count += 1
        if len(out) >= MAX_PER_FILE:
            continue
        start_line = text.count("\n", 0, m.start()) + 1
        first_line = (lines[start_line - 1] if start_line - 1 < len(lines) else "")
        entry = {
            "file": rel,
            "line": start_line,
            "content": redact_sensitive_content(first_line.rstrip()[:300]),
        }
        if context:
            i = start_line - 1
            lo, hi = max(0, i - context), min(len(lines), i + context + 1)
            rows = [f"{j + 1:>5}{':' if j == i else '-'} {lines[j].rstrip()[:200]}"
                    for j in range(lo, hi)]
            entry["snippet"] = redact_sensitive_content("\n".join(rows))
        out.append(entry)
    return out, count


def _walk_files(root: Path, file_pattern: str = None, policy=None):
    policy = policy or scan_policy.build(str(root))
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        if rel_dir == ".":
            rel_dir = ""
        # The child's relative PATH is what makes targeting work — pruning
        # by name alone cannot tell the node_modules the user asked about
        # from every other one in the tree.
        dirnames[:] = [
            d for d in dirnames
            if not policy.skip_dir(d, f"{rel_dir}/{d}" if rel_dir else d)
        ]
        for filename in filenames:
            file_path = Path(dirpath) / filename
            if policy.skip_file(filename):
                continue
            if file_pattern and not _glob_match(file_path, root, file_pattern):
                continue
            yield file_path


def _glob_match(file_path: Path, root: Path, pattern: str) -> bool:
    """Match both '*.py' (basename, any depth) and 'src/**/*.py' (path) the
    way ripgrep's gitignore-style globs do — pathlib alone treats '**'
    inconsistently across Python versions."""
    rel = str(file_path.relative_to(root)).replace("\\", "/")
    if "/" not in pattern and "**" not in pattern:
        return file_path.match(pattern)
    regex = re.escape(pattern)
    regex = regex.replace(r"\*\*/", "(?:.*/)?").replace(r"\*\*", ".*")
    regex = regex.replace(r"\*", "[^/]*").replace(r"\?", ".")
    return re.fullmatch(regex, rel, re.IGNORECASE) is not None


# ── Shared result rendering ──────────────────────────────────────────────────

def _relativise(p: str, root: Path) -> str:
    """Workspace-relative POSIX path for whatever the engine reported.

    rg is run from the workspace with "." as its search path, so it emits
    "./src/app.js"; the Python engine emits an already-relative path. Both
    shapes — and an absolute path, should either ever produce one — have to
    land on the same string, because the model uses it as a read_file
    argument and a "./" prefix is a different path to some tools.
    """
    text = str(p).replace("\\", "/")
    if text.startswith("./"):
        text = text[2:]
    if os.path.isabs(text):
        try:
            return str(Path(text).relative_to(root)).replace("\\", "/")
        except ValueError:
            return text
    return text


def _render_content(matches, query, limit, offset, engine):
    # Deterministic order is what makes `offset` MEAN something: ripgrep's
    # parallel directory walk returns files in a different order on every
    # invocation, so page 2 of an unsorted result set could overlap page 1 or
    # skip matches entirely. Sorted by (file, line), two calls see one stable
    # sequence — and the model gets reproducible results besides.
    matches = sorted(matches, key=lambda m: (m["file"], m["line"]))
    total = len(matches)
    window = matches[offset:offset + limit]
    if not window:
        return {
            "query": query,
            "matches": [],
            "total_matches": total,
            "engine": engine,
            "message": (f"No matches found for '{query}'" if total == 0 else
                        f"Offset {offset} is past the end ({total} matches)."),
        }
    result = {
        "query": query,
        "matches": window,
        "total_matches": total,
        "files_with_matches": len({m["file"] for m in window}),
        "engine": engine,
    }
    if offset:
        result["offset"] = offset
    if total > offset + len(window):
        # Say what was NOT shown — silent truncation reads as "that's all".
        result["truncated"] = True
        result["message"] = (
            f"Showing {len(window)} of {total} matches "
            f"(each file capped at {MAX_PER_FILE}). Narrow with file_pattern, "
            f"page with offset={offset + len(window)}, or survey with "
            f"output_mode='files_with_matches'."
        )
    return result


def _render_survey(raw_output, root, query, output_mode, limit, offset,
                   engine, files_searched=None):
    """Shape rg --files-with-matches / --count-matches output (one file[:count]
    per line) into the survey result."""
    entries = []
    for line in (raw_output or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if output_mode == "count":
            path, _, count = line.rpartition(":")
            if not path:  # no colon — a bare path (python engine edge)
                path, count = line, "1"
            try:
                entries.append((path, int(count)))
            except ValueError:
                entries.append((line, 1))
        else:
            entries.append((line, None))

    entries = [(_relativise(p, root), c) for p, c in entries]
    # Deterministic order (rg's parallel walk isn't): hot spots first in count
    # mode — the distribution IS the answer — with path as the tiebreak;
    # plain path order for the file list.
    if output_mode == "count":
        entries.sort(key=lambda e: (-e[1], e[0]))
    else:
        entries.sort(key=lambda e: e[0])

    total = len(entries)
    window = entries[offset:offset + limit]

    result = {
        "query": query,
        "output_mode": output_mode,
        "total_files": total,
        "engine": engine,
    }
    if files_searched is not None:
        result["files_searched"] = files_searched
    if output_mode == "count":
        result["counts"] = [{"file": p, "matches": c} for p, c in window]
        result["total_matches"] = sum(c for _, c in entries)
    else:
        result["files"] = [p for p, _ in window]
    if total == 0:
        result["message"] = f"No matches found for '{query}'"
    elif total > offset + len(window):
        result["truncated"] = True
        result["message"] = (
            f"Showing {len(window)} of {total} files. "
            f"Page with offset={offset + len(window)} or narrow with file_pattern."
        )
    return result
