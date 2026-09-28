"""Skill catalog — how the agent finds and loads a workspace's methodology.

Three pieces, in the order a turn uses them:

    catalog.py    discovery → one flat catalog of every definition, whatever
                  framework shipped it and whatever kind it declares
    variables.py  the {project-root} / {user_name} / {planning_artifacts}
                  substitution a real framework file is written against
    closure.py    a loaded file names its parents and siblings; following
                  those to completion is what makes an import actually work

The catalog is injected whole into the system prompt as name + description
(one line each), and bodies are pulled on demand — the same progressive
disclosure Claude Code and GitHub Copilot use. There is no retrieval step
and no index: an agent picks what it needs by reading the descriptions.
"""

from .catalog import (
    SkillEntry,
    build_catalog,
    find_entry,
    load_body,
    render_agents_block,
    render_catalog,
)
from .closure import resolve_closure
from .variables import (
    build_session_scope,
    module_scope_for,
    render_session_variables,
    substitute,
)

__all__ = [
    "SkillEntry",
    "build_catalog",
    "find_entry",
    "load_body",
    "render_agents_block",
    "render_catalog",
    "resolve_closure",
    "build_session_scope",
    "module_scope_for",
    "render_session_variables",
    "substitute",
]
