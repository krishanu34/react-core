"""
Dynamic scan policy — the directories a search may walk, decided per call.

What is being pinned down: a question ABOUT a dependency has to be answerable.
With a frozen `_IGNORE_DIRS` constant it was not — "which version of this
library is actually installed and does it do what the docs say" had no path to
an answer, so the agent answered from memory instead of evidence, which is the
failure mode users report as hallucination.
"""

import os
from pathlib import Path

import pytest

from context import scan_policy


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "src" / "app").mkdir(parents=True)
    (tmp_path / "node_modules" / "express" / "lib").mkdir(parents=True)
    (tmp_path / "node_modules" / "lodash").mkdir(parents=True)
    (tmp_path / ".venv" / "Lib").mkdir(parents=True)
    (tmp_path / "build").mkdir()
    (tmp_path / ".git").mkdir()
    (tmp_path / ".github" / "workflows").mkdir(parents=True)
    return tmp_path


# ── Defaults ─────────────────────────────────────────────────────────────────

def test_noise_is_pruned_by_default(project):
    p = scan_policy.build(str(project))
    for name in ("node_modules", ".venv", "build", "__pycache__", "dist"):
        assert p.skip_dir(name, name), name


def test_hard_skips_are_absolute(project):
    """.git and .devaccel are plumbing — no flag reaches them, because no
    question about the user's code is answered there and both are enormous."""
    for p in (
        scan_policy.build(str(project)),
        scan_policy.build(str(project), include_ignored=True),
        scan_policy.build(str(project), path=".git"),
    ):
        assert p.skip_dir(".git", ".git")
        assert p.skip_dir(".devaccel", ".devaccel")


def test_github_is_not_treated_as_tool_state(project):
    """Dotted directories are pruned by convention, but .github holds
    workflows people genuinely search for."""
    p = scan_policy.build(str(project))
    assert not p.skip_dir(".github", ".github")
    assert p.skip_dir(".idea", ".idea")


def test_source_directories_are_never_pruned(project):
    p = scan_policy.build(str(project))
    assert not p.skip_dir("src", "src")
    assert not p.skip_dir("app", "src/app")


# ── Layer 1: explicit targeting ──────────────────────────────────────────────

def test_targeting_a_dependency_unlocks_it(project):
    """Asking about node_modules/express IS the answer to 'should we look
    there?'. This is the mechanism that makes the choice dynamic without
    inventing a new one — the model steers by aiming."""
    p = scan_policy.build(str(project), path="node_modules/express")
    assert not p.skip_dir("express", "node_modules/express")
    assert not p.skip_dir("lib", "node_modules/express/lib")


def test_targeting_unlocks_the_path_DOWN_to_the_target(project):
    """Pruning `node_modules` while targeting `node_modules/express` would
    make targeting a no-op: the walk could never reach the target."""
    p = scan_policy.build(str(project), path="node_modules/express")
    assert not p.skip_dir("node_modules", "node_modules")


def test_targeting_one_dependency_does_not_open_the_others(project):
    """The narrow override is the point. Aiming at express must not turn every
    other ignored directory into search noise."""
    p = scan_policy.build(str(project), path="node_modules/express")
    assert p.skip_dir(".venv", ".venv")
    assert p.skip_dir("build", "build")


def test_a_glob_rooted_in_a_dependency_targets_it(project):
    """A file_pattern pointing inside node_modules is as explicit a request as
    passing `path`."""
    p = scan_policy.build(str(project), file_pattern="node_modules/express/**/*.js")
    assert p.targets == ("node_modules/express",)
    assert not p.skip_dir("express", "node_modules/express")


@pytest.mark.parametrize("pattern,expected", [
    ("node_modules/express/**/*.js", "node_modules/express"),
    ("src/**/*.py", "src"),
    ("*.py", ""),
    ("**/*.ts", ""),
    ("src/utils/helpers.py", "src/utils/helpers.py"),
    ("", ""),
])
def test_literal_prefix(pattern, expected):
    assert scan_policy.literal_prefix(pattern) == expected


def test_a_wildcard_only_pattern_targets_nothing(project):
    """`*.py` aims nowhere, so it must not accidentally unlock anything."""
    p = scan_policy.build(str(project), file_pattern="*.py")
    assert p.targets == ()
    assert p.skip_dir("node_modules", "node_modules")


# ── Layer 2: include_ignored ─────────────────────────────────────────────────

def test_include_ignored_opens_everything_but_the_hard_skips(project):
    p = scan_policy.build(str(project), include_ignored=True)
    assert not p.skip_dir("node_modules", "node_modules")
    assert not p.skip_dir(".venv", ".venv")
    assert p.skip_dir(".git", ".git")


def test_include_ignored_adds_no_ignore_for_ripgrep(project):
    """Without --no-ignore, rg still honours the project's .gitignore and the
    opt-in appears to do nothing — the user sets the flag and still gets no
    results, which reads as a broken tool."""
    p = scan_policy.build(str(project), include_ignored=True)
    assert "--no-ignore" in p.rg_extra_args()
    assert p.rg_exclude_globs() == []


def test_default_ripgrep_exclusions_are_recursive(project):
    """`!node_modules/**` would exclude only the TOP-LEVEL one, while
    packages/*/node_modules still floods results — brownfield monorepos are
    exactly where that bites."""
    globs = scan_policy.build(str(project)).rg_exclude_globs()
    assert "!**/node_modules/**" in globs
    assert all(g.startswith("!**/") for g in globs)


# ── Layer 3: the project's own declaration ───────────────────────────────────

def test_gitignore_directories_are_honoured(project):
    """`generated/` is nobody's convention — only this repo knows it is
    output. A constant cannot know that; the project already wrote it down."""
    (project / ".gitignore").write_text("generated/\n*.log\n# comment\n!keep/\n")
    p = scan_policy.build(str(project))
    assert p.from_project
    assert p.skip_dir("generated", "generated")


def test_project_rules_supplement_rather_than_replace(project):
    """A .gitignore that happens not to mention __pycache__ must not make
    __pycache__ suddenly searchable."""
    (project / ".gitignore").write_text("generated/\n")
    p = scan_policy.build(str(project))
    assert p.skip_dir("__pycache__", "__pycache__")
    assert p.skip_dir("node_modules", "node_modules")


def test_wildcard_gitignore_lines_are_ignored(project):
    """Half-implementing gitignore semantics is worse than not reading the
    file: a pattern we resolve wrongly hides a directory nobody asked to hide,
    and the symptom is a search that silently misses the answer."""
    (project / ".gitignore").write_text("**/temp-*/\nsrc/*.gen.ts\n")
    p = scan_policy.build(str(project))
    assert not p.skip_dir("src", "src")


def test_no_ignore_file_falls_back_to_defaults(project):
    """Brownfield trees arrive as a zip with no .git and no .gitignore. A
    default of 'search node_modules' would bury every result."""
    p = scan_policy.build(str(project))
    assert not p.from_project
    assert p.skip_dir("node_modules", "node_modules")


# ── Files ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", ["a.pyc", "logo.png", "bundle.min.js",
                                  "app.min.css", "lib.so", "x.class"])
def test_binary_and_generated_files_are_skipped(name):
    assert scan_policy.build(".").skip_file(name)


@pytest.mark.parametrize("name", ["app.py", "index.ts", "README.md",
                                  "schema.sql", "Dockerfile"])
def test_source_files_are_kept(name):
    assert not scan_policy.build(".").skip_file(name)


def test_include_ignored_does_not_unlock_binaries():
    """Nobody grepping a dependency wants .pyc or sourcemap hits — the flag is
    about DIRECTORIES."""
    p = scan_policy.build(".", include_ignored=True)
    assert p.skip_file("mod.pyc")
    assert p.skip_file("bundle.min.js")


# ── Reporting ────────────────────────────────────────────────────────────────

def test_scope_is_described(project):
    """Silence reads as absence. If a search was narrowed, the result has to
    say so, or 'no matches' is indistinguishable from 'not looked at'."""
    assert "skipped" in scan_policy.build(str(project)).describe()
    assert "everything" in scan_policy.build(str(project), include_ignored=True).describe()
    assert "targeted" in scan_policy.build(str(project), path="node_modules").describe()
