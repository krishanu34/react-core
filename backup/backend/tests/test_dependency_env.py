"""
Dependency-environment evidence — facts for the model, not a rule.

This replaced a Python-only mechanism that detected `pip install`, created
`.venv` and rewrote PATH before every spawn. That was wrong in a way worth
keeping a record of:

  • It knew one language. Java's isolation problem is the shared ~/.m2 and a
    pinned JDK, Node's is `-g` versus local, Ruby's is bundler's path, Go's is
    the module cache. Those need different actions, not the same one.
  • It was a regex of Python binaries, so any Python tool nobody listed fell
    through silently.
  • It made a decision the model was better placed to make.

So the split is: this module reports WHAT IS, and
prompts/skills/project_environment.md carries the reasoning about what to do.
These tests cover the facts. The reasoning is prose and is not asserted here.
"""

from pathlib import Path

import pytest

from context.dependency_env import as_prompt_lines, detect


def _by_ecosystem(findings):
    return {f.ecosystem: f for f in findings}


# ── Breadth: many ecosystems, not one ────────────────────────────────────────

@pytest.mark.parametrize("manifest,ecosystem", [
    ("requirements.txt", "python"),
    ("pyproject.toml", "python"),
    ("package.json", "node"),
    ("pom.xml", "java-maven"),
    ("build.gradle", "java-gradle"),
    ("build.gradle.kts", "java-gradle"),
    ("go.mod", "go"),
    ("Cargo.toml", "rust"),
    ("Gemfile", "ruby"),
    ("composer.json", "php"),
    ("mix.exs", "elixir"),
    ("pubspec.yaml", "dart"),
    ("Package.swift", "swift"),
    ("build.sbt", "scala-sbt"),
    ("cpanfile", "perl"),
    ("renv.lock", "r"),
    ("stack.yaml", "haskell"),
    ("deno.json", "deno"),
])
def test_each_ecosystem_is_recognised(tmp_path, manifest, ecosystem):
    (tmp_path / manifest).write_text("{}")
    found = _by_ecosystem(detect(str(tmp_path)))
    assert ecosystem in found, f"{manifest} should report {ecosystem}, got {list(found)}"


def test_glob_manifests_are_matched(tmp_path):
    """.NET names its manifest after the project, so it can only be found by
    pattern — a literal-filename-only matcher misses the whole ecosystem."""
    (tmp_path / "Api.csproj").write_text("<Project/>")
    assert "dotnet" in _by_ecosystem(detect(str(tmp_path)))


def test_an_unknown_ecosystem_reports_nothing_rather_than_guessing(tmp_path):
    """Silence is the safe failure. A language this table has never heard of
    must not be described using the nearest row's rules."""
    (tmp_path / "Makefile").write_text("all:\n\techo hi\n")
    (tmp_path / "main.zig").write_text("pub fn main() void {}")
    assert detect(str(tmp_path)) == []


# ── Isolation state ──────────────────────────────────────────────────────────

def test_python_without_a_venv_is_reported_as_not_isolated(tmp_path):
    (tmp_path / "requirements.txt").write_text("fastapi\n")
    f = _by_ecosystem(detect(str(tmp_path)))["python"]
    assert f.isolated is False
    assert "global site-packages" in f.note


def test_python_with_a_venv_is_reported_as_isolated(tmp_path):
    (tmp_path / "requirements.txt").write_text("fastapi\n")
    (tmp_path / ".venv").mkdir()
    f = _by_ecosystem(detect(str(tmp_path)))["python"]
    assert f.isolated is True
    assert f.local_env == ".venv"
    assert f.note == ""      # nothing to warn about, so nothing is said


def test_node_with_modules_installed_is_isolated(tmp_path):
    """Node is the contrast case: its DEFAULT is already project-local, so the
    evidence should not imply a problem where there is none."""
    (tmp_path / "package.json").write_text("{}")
    (tmp_path / "node_modules").mkdir()
    f = _by_ecosystem(detect(str(tmp_path)))["node"]
    assert f.isolated is True


def test_a_manager_that_owns_its_environment_is_named_as_such(tmp_path):
    """poetry/pipenv/uv/conda create and select their own environment. Telling
    the model to make a venv beside one of those gives the project two."""
    (tmp_path / "pyproject.toml").write_text("[tool.poetry]\n")
    (tmp_path / "poetry.lock").write_text("")
    found = _by_ecosystem(detect(str(tmp_path)))
    assert "python-poetry" in found
    assert "poetry" in found["python-poetry"].note.lower()


def test_wrappers_count_as_project_local_toolchain(tmp_path):
    """./gradlew IS the isolation mechanism for Gradle — it pins the version
    the build runs with. Reporting a wrapped project as unmanaged would push
    the model toward a system `gradle` that may be any version at all."""
    (tmp_path / "build.gradle").write_text("plugins {}")
    (tmp_path / "gradlew").write_text("#!/bin/sh\n")
    assert _by_ecosystem(detect(str(tmp_path)))["java-gradle"].isolated is True


# ── Monorepo layout ──────────────────────────────────────────────────────────

def test_each_subproject_is_reported_separately(tmp_path):
    """The layout the agent itself generates. Reporting only the root would
    miss every manifest and describe a polyglot repo as having none."""
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "requirements.txt").write_text("fastapi\n")
    (tmp_path / "frontend").mkdir()
    (tmp_path / "frontend" / "package.json").write_text("{}")
    (tmp_path / "frontend" / "node_modules").mkdir()
    (tmp_path / "service").mkdir()
    (tmp_path / "service" / "pom.xml").write_text("<project/>")

    found = _by_ecosystem(detect(str(tmp_path)))
    assert set(found) == {"python", "node", "java-maven"}
    assert found["python"].manifest == "backend/requirements.txt"
    assert found["python"].isolated is False
    assert found["node"].local_env == "frontend/node_modules"


def test_the_scan_does_not_descend_into_dependencies(tmp_path):
    """A package.json inside node_modules is somebody else's project. Walking
    into them would report hundreds of ecosystems and cost a fortune."""
    dep = tmp_path / "node_modules" / "express"
    dep.mkdir(parents=True)
    (dep / "package.json").write_text("{}")
    (tmp_path / "package.json").write_text("{}")

    findings = detect(str(tmp_path))
    assert [f.manifest for f in findings] == ["package.json"]


# ── Prompt block ─────────────────────────────────────────────────────────────

def test_empty_workspace_costs_no_tokens(tmp_path):
    assert as_prompt_lines(detect(str(tmp_path))) == ""


def test_prompt_block_states_the_consequence_not_an_order(tmp_path):
    """The block is evidence. It says where packages WOULD go; choosing what
    to do is the model's call, informed by the project_environment skill."""
    (tmp_path / "Gemfile").write_text("source 'https://rubygems.org'\n")
    block = as_prompt_lines(detect(str(tmp_path)))
    assert "ruby" in block
    assert "system-wide" in block


def test_findings_are_json_serialisable(tmp_path):
    """They travel to the client inside project_context's result."""
    import json
    (tmp_path / "go.mod").write_text("module x\n")
    json.dumps([f.to_dict() for f in detect(str(tmp_path))])


def test_scanner_exposes_the_findings(tmp_path):
    """The evidence is worthless if project_context does not carry it."""
    from context.project_scanner import invalidate_cache, scan_project
    (tmp_path / "requirements.txt").write_text("fastapi\n")
    invalidate_cache()
    ctx = scan_project(str(tmp_path), force=True)
    assert ctx.to_dict()["dependency_environments"]
    assert "Dependency environments:" in ctx.as_prompt_context()
