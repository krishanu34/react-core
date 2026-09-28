"""Link closure — following a definition to the things that complete it.

A skill is rarely self-contained. A BMAD agent's Capabilities table names the
skills it can run; each of those names a template and a checklist; each of
those sits under a module config that supplies the paths they write to. Load
only the file the user asked for and the model has one node of a graph.

    agent(migration-lead)
      ├─ links → skill(expand-contract) → template(migration-plan)
      │                                 └─ checklist(rollback-drill)
      └─ parents → .devaccel/core-config.yaml

`resolve_closure` walks that graph breadth-first and returns an ORDERED LOAD
LIST, not concatenated text. Returning the list rather than the content is the
whole discipline of progressive disclosure: the model sees what exists and
pulls only as deep as the task needs, instead of paying for a framework's
entire dependency tree on every turn.

Bounded three ways, because these files come from outside and cycles are
normal in hand-written frameworks: a visited set, a hop cap, and an entry cap.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .catalog import SkillEntry, find_entry

MAX_HOPS = 3
MAX_ENTRIES = 25


@dataclass
class Closure:
    """What loading one entry pulls into view."""
    root: str
    load_order: List[SkillEntry] = field(default_factory=list)
    parents: List[str] = field(default_factory=list)      # config file paths
    resources: List[str] = field(default_factory=list)    # bundled files
    missing: List[str] = field(default_factory=list)      # names nothing matched
    truncated: bool = False

    def as_text(self) -> str:
        """The 'what to load next' section appended to a loaded body."""
        lines: List[str] = []
        related = [e for e in self.load_order if e.name != self.root]
        if related:
            lines.append("Related entries this one points at — load by exact "
                         "name with skill(\"<name>\"), or read the file directly. "
                         "Do not invent names that are not listed:")
            for entry in related:
                label = f"{entry.name} [{entry.kind}]"
                where = entry.source or "builtin"
                lines.append(f"  - {label}: {entry.description or where} ({where})")
        if self.resources:
            lines.append("Bundled files in this entry's folder (read on demand):")
            lines += [f"  - {path}" for path in self.resources]
        if self.missing:
            lines.append(
                "Referenced but NOT found in this workspace: "
                + ", ".join(self.missing)
                + ". The framework may be partially installed — say so rather "
                  "than improvising a replacement.")
        if self.truncated:
            lines.append("(The link graph goes deeper than this listing; load "
                         "one of the above to see its own links.)")
        return "\n".join(lines)


def resolve_closure(entry: SkillEntry, catalog: List[SkillEntry],
                    max_hops: int = MAX_HOPS,
                    max_entries: int = MAX_ENTRIES) -> Closure:
    """Everything reachable from `entry` within `max_hops`, breadth-first.

    Breadth-first matters: the entry's own direct links are the ones most
    likely to be needed, and a depth-first walk would spend the entry budget
    on one deep branch before ever listing a sibling.
    """
    closure = Closure(root=entry.name, load_order=[entry],
                      parents=list(entry.parent_chain),
                      resources=list(entry.resources))
    by_name: Dict[str, SkillEntry] = {e.name: e for e in catalog}
    seen = {entry.name}
    missing: List[str] = []

    queue: deque = deque((name, 1) for name in entry.links)
    while queue:
        name, hop = queue.popleft()
        if name in seen:
            continue                      # already listed, or a cycle
        seen.add(name)

        found = by_name.get(name) or find_entry(catalog, name)
        if found is None:
            # Only report a name that looks like it MEANT to be an entry.
            # Capabilities tables are scraped generously, so plenty of
            # harmless table cells arrive here and must not become noise.
            if "-" in name or "_" in name:
                missing.append(name)
            continue

        if len(closure.load_order) >= max_entries:
            closure.truncated = True
            break
        closure.load_order.append(found)
        for path in found.parent_chain:
            if path not in closure.parents:
                closure.parents.append(path)

        if hop < max_hops:
            queue.extend((link, hop + 1) for link in found.links if link not in seen)
        elif found.links:
            closure.truncated = True

    closure.missing = missing[:10]
    return closure
