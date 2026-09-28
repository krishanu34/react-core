"""
Spec-mode execution scheduler.

parse_tasks() has always returned `requires` and `parallel` per task; the
executor ignored both and ran pending[0] one at a time. These cover the
ready-set logic that finally uses them.

tasks.md format is the GitHub Spec Kit convention (see spec_driven/parsers.py):
    - [ ] T001 Create user table migration [P] requires:T000
"""

from __future__ import annotations

from spec_driven.parsers import parse_tasks
from spec_driven.workflow import _ready_batch


def _batch_ids(md: str):
    return [t["id"] for t in _ready_batch(parse_tasks(md))]


def test_fixtures_parse_as_expected():
    """Guard the fixtures themselves — a silent parse failure would make every
    other assertion in this file vacuously pass."""
    tasks = parse_tasks("- [ ] T001 Models [P] requires:T000\n")
    assert tasks and tasks[0]["id"] == "T001"
    assert tasks[0]["parallel"] is True
    assert tasks[0]["requires"] == ["T000"]


def test_sequential_spec_still_runs_one_at_a_time():
    md = "- [ ] T001 First\n- [ ] T002 Second\n"
    assert _batch_ids(md) == ["T001"]


def test_parallel_marked_tasks_batch_together():
    md = (
        "- [ ] T001 Models [P]\n"
        "- [ ] T002 Routes [P]\n"
        "- [ ] T003 Docs [P]\n"
    )
    assert _batch_ids(md) == ["T001", "T002", "T003"]


def test_batch_stops_at_the_first_non_parallel_task():
    md = (
        "- [ ] T001 Models [P]\n"
        "- [ ] T002 Routes [P]\n"
        "- [ ] T003 Migrate\n"
    )
    assert _batch_ids(md) == ["T001", "T002"]


def test_dependent_task_waits_for_its_requirement():
    md = "- [ ] T001 Schema\n- [ ] T002 Seed requires:T001\n"
    assert _batch_ids(md) == ["T001"], "T002 must not run before T001 is done"


def test_dependent_task_becomes_ready_once_requirement_is_ticked():
    md = "- [x] T001 Schema\n- [ ] T002 Seed requires:T001\n"
    assert _batch_ids(md) == ["T002"]


def test_parallel_tasks_still_respect_dependencies():
    md = (
        "- [x] T001 Schema\n"
        "- [ ] T002 Seed [P] requires:T001\n"
        "- [ ] T003 Index [P] requires:T001\n"
        "- [ ] T004 Report [P] requires:T099\n"
    )
    ids = _batch_ids(md)
    assert "T002" in ids and "T003" in ids
    assert "T004" not in ids, "unmet dependency must not be dispatched"


def test_multiple_requirements_all_must_be_met():
    md = (
        "- [x] T001 A\n"
        "- [ ] T002 B\n"
        "- [ ] T003 C requires:T001,T002\n"
    )
    assert "T003" not in _batch_ids(md)


def test_everything_done_yields_no_batch():
    assert _ready_batch(parse_tasks("- [x] T001 Done\n")) == []


def test_unsatisfiable_dependency_yields_no_batch():
    """The caller turns this into a 'blocked' outcome rather than looping."""
    assert _ready_batch(parse_tasks("- [ ] T001 Ghost requires:T099\n")) == []


def test_phase_headings_do_not_break_batching():
    md = (
        "## Setup\n"
        "- [ ] T001 Models [P]\n"
        "- [ ] T002 Routes [P]\n"
    )
    assert _batch_ids(md) == ["T001", "T002"]
