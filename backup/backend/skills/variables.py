"""Variable resolution — the context a framework file is written against.

Real skill files are templates. A BMAD agent opens with:

    Load config from {project-root}/_bmad/bmm/config.yaml and resolve:
      Use {user_name} for greeting
      Use {planning_artifacts} for output location

and a Copilot session declares its own set up front ("When a skill references
{{VSCODE_VARIABLE_NAME}}, substitute the corresponding value above"). Load a
file without resolving those and the model gets instructions full of holes.

Two layers:

    session   ours — project-root, user_name, output_folder, date, os …
              declared once in the system prompt so ANY file written against
              a placeholder behaves predictably
    module    theirs — every scalar in the config files on the entry's
              parent chain, nearest ancestor winning

What can't be resolved is never left dangling. The loader reports the unknown
names AND the config files on the chain, so the model can read its own way to
the value. That fallback is what makes this work for a framework we have
never seen.
"""

from __future__ import annotations

import platform
import re
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from agents.custom_agent_registry import _read_capped
from utils.logger import get_logger

log = get_logger(__name__)

# {name} and {{NAME}} — the two spellings in the wild. Keys are permissive
# (kebab, snake, dotted) because frameworks disagree about style.
_PLACEHOLDER_RE = re.compile(r"\{\{?\s*([a-zA-Z][a-zA-Z0-9_.\-]{0,63})\s*\}?\}")
# Whether an unfilled `{token}` is worth REPORTING as a missing variable.
# Substitution itself is driven by the scope — anything named there gets
# replaced whatever its length. But skill bodies are full of code, and JSX
# `v={x}` or a shell `${i}` would otherwise be reported as variables the user
# needs to go define. A real config key is a word, so require one: three or
# more characters, or a separator.
_LOOKS_LIKE_A_VARIABLE = re.compile(r"^(?=.{3,})[a-zA-Z][a-zA-Z0-9]*([_.\-][a-zA-Z0-9]+)*$")
# A flat `key: value` line. Deliberately NOT a YAML parse: these files are
# untrusted, and every value we want is a top-level scalar. Nested blocks are
# skipped rather than guessed at.
_SCALAR_RE = re.compile(r"^(?P<key>[A-Za-z][A-Za-z0-9_.\-]{0,63})\s*:\s*(?P<value>\S.*?)\s*$")
_MAX_CONFIG_KEYS = 60
_MAX_RESOLVE_PASSES = 3


def build_session_scope(workspace: str = "", user_name: str = "",
                        thread_id: str = "", output_folder: str = "",
                        extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """The values we own. `project-root` and `project_root` are both set —
    frameworks spell it both ways and neither should be a miss."""
    root = str(Path(workspace).as_posix()) if workspace else "."
    scope = {
        "project-root": root,
        "project_root": root,
        "workspace": root,
        "user_name": user_name or "the user",
        "thread_id": thread_id or "",
        "date": date.today().isoformat(),
        "os": platform.system().lower(),
        "output_folder": output_folder or ".devaccel/output",
        "communication_language": "English",
        "document_output_language": "English",
    }
    scope.update({k: str(v) for k, v in (extra or {}).items() if v is not None})
    return scope


def _read_config(path: Path) -> Dict[str, str]:
    """Top-level scalars from one config file. Comments, list items and
    nested mappings are ignored — we want variables, not a config model."""
    content = _read_capped(path)
    if content is None:
        return {}
    out: Dict[str, str] = {}
    for line in content.splitlines():
        if not line or line[0].isspace() or line.lstrip().startswith("#"):
            continue          # indented → nested; '#' → comment
        m = _SCALAR_RE.match(line)
        if not m:
            continue
        value = m.group("value")
        if value.startswith(("|", ">", "&", "*")):
            continue          # block scalar / anchor — not a plain value
        out[m.group("key")] = value.strip().strip("'\"")
        if len(out) >= _MAX_CONFIG_KEYS:
            break
    return out


def module_scope_for(workspace: str, parent_chain: List[str],
                     session: Dict[str, str]) -> Dict[str, str]:
    """Every scalar from the entry's parent config files, NEAREST FIRST.

    A module config may itself be written in placeholders
    (`planning_artifacts: "{project-root}/_bmad-output/planning-artifacts"`),
    so values are resolved against the session scope as they are read.
    """
    scope: Dict[str, str] = {}
    root = Path(workspace) if workspace else None
    for rel in parent_chain:
        if root is None:
            break
        for key, value in _read_config(root / rel).items():
            if key not in scope:          # nearest ancestor already won
                scope[key] = substitute(value, session)[0]
    return scope


def substitute(text: str, scope: Dict[str, str]) -> Tuple[str, List[str]]:
    """(resolved text, sorted names that had no value).

    Targeted replacement, never str.format() — skill bodies are full of JSON
    and JSX braces, and formatting one of those raises KeyError on content
    that was never a placeholder. This is the same reasoning as
    prompts/loader.py's substitution.

    Runs a few passes so a value that is itself a template resolves too, and
    stops as soon as a pass changes nothing.
    """
    if not text:
        return text or "", []

    unresolved: set = set()
    result = text
    for _ in range(_MAX_RESOLVE_PASSES):
        names = {m.group(1) for m in _PLACEHOLDER_RE.finditer(result)}
        if not names:
            break
        changed = False
        for name in names:
            value = scope.get(name)
            if value is None:
                unresolved.add(name)
                continue
            for form in ("{{" + name + "}}", "{" + name + "}"):
                if form in result:
                    result = result.replace(form, str(value))
                    changed = True
        if not changed:
            break

    # A name resolved on a later pass is not unresolved, and a token that
    # isn't variable-shaped was never a variable.
    still_open = {m.group(1) for m in _PLACEHOLDER_RE.finditer(result)}
    return result, sorted(
        n for n in unresolved & still_open if _LOOKS_LIKE_A_VARIABLE.match(n)
    )


def render_session_variables(scope: Dict[str, str]) -> str:
    """The block that tells the model what it may substitute — phrased the way
    the Copilot harness phrases it, because skill files are written expecting
    exactly that contract."""
    if not scope:
        return ""
    shown = [(k, v) for k, v in sorted(scope.items()) if v and k != "thread_id"]
    if not shown:
        return ""
    lines = ["The following session variables are available. When a skill or "
             "agent file references {name} or {{NAME}}, substitute the value "
             "below:"]
    lines += [f"- {key}: {value}" for key, value in shown]
    return "\n".join(lines)


def render_unresolved(unresolved: List[str], parent_chain: List[str]) -> str:
    """What to tell the model about placeholders we could not fill.

    Naming the config files is the point: an unresolved variable becomes a
    read the model can do for itself, instead of an instruction it has to
    guess at or ignore.
    """
    if not unresolved:
        return ""
    lines = [f"Unresolved variables: {', '.join('{' + n + '}' for n in unresolved)}"]
    if parent_chain:
        lines.append("Config files on this entry's parent chain — read them if "
                     "you need those values:")
        lines += [f"  {path}" for path in parent_chain]
    else:
        lines.append("No config file was found above this entry. Ask the user "
                     "for these values, or search the workspace for them.")
    return "\n".join(lines)
