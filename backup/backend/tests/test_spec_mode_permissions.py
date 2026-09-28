"""
Both modes must work in BOTH run types: a normal agent turn and a
spec-driven workflow.

The bug this pins down was silent and complete: `SpecWorkflow._run_phase`
built a fresh `PermissionConfig(mode="auto", allow_write_paths=…)` for every
phase. It needed the write fence, and it took the whole config with it — so a
user who selected manual mode got spec generation and execution running fully
unattended, editing and executing without a single approval prompt. Nothing
errored; the prompts simply never appeared, which is the hardest kind of
permission bug to notice.

The fix is that a phase LAYERS its fence onto the request's own config instead
of replacing it. These tests assert the four combinations directly, because
"we changed it to use replace()" is not the same claim as "manual mode asks
during a spec phase".
"""

from dataclasses import replace

import pytest

from context.permissions import (
    MODE_AUTO,
    MODE_MANUAL,
    PermissionConfig,
    check_path_permission,
    check_tool_permission,
    set_config,
)

SPEC_FENCE = [".devaccel/spec/**"]


def _phase_config(request_config: PermissionConfig) -> PermissionConfig:
    """Exactly what SpecWorkflow._run_phase now does — the fence is added to
    the REQUEST's config, not substituted for it."""
    return replace(request_config, allow_write_paths=list(SPEC_FENCE))


# ── Normal run ───────────────────────────────────────────────────────────────

def test_normal_run_manual_asks_before_a_change():
    set_config(".", PermissionConfig(mode=MODE_MANUAL))
    r = check_tool_permission("file_write", arguments={"path": "src/app.py"})
    assert r.ask and not r.allowed


def test_normal_run_auto_does_not_ask():
    set_config(".", PermissionConfig(mode=MODE_AUTO))
    r = check_tool_permission("file_write", arguments={"path": "src/app.py"})
    assert r.allowed and not r.ask


# ── Spec run ─────────────────────────────────────────────────────────────────

def test_spec_phase_in_manual_mode_still_asks():
    """The regression. Before the fix this returned allowed=True because the
    phase config hard-coded auto."""
    phase = _phase_config(PermissionConfig(mode=MODE_MANUAL))
    set_config(".", phase)

    assert phase.mode == MODE_MANUAL
    r = check_tool_permission("file_write", arguments={"path": ".devaccel/spec/prd.md"})
    assert r.ask and not r.allowed


def test_spec_phase_in_manual_mode_labels_high_impact_calls():
    """Argument-aware gating is not lost inside a phase either — a phase that
    writes a workflow file should say so on the card."""
    set_config(".", _phase_config(PermissionConfig(mode=MODE_MANUAL)))
    r = check_tool_permission("file_write",
                              arguments={"path": ".github/workflows/deploy.yml"})
    assert r.ask and r.category == "infrastructure"


def test_spec_phase_in_auto_mode_does_not_ask():
    set_config(".", _phase_config(PermissionConfig(mode=MODE_AUTO)))
    r = check_tool_permission("file_write", arguments={"path": ".devaccel/spec/prd.md"})
    assert r.allowed and not r.ask


# ── The fence itself survives in both modes ──────────────────────────────────

@pytest.mark.parametrize("mode", [MODE_MANUAL, MODE_AUTO])
def test_the_write_fence_holds_in_both_modes(mode):
    """The fence is a phase boundary, not a safety prompt: it must apply in
    auto too, or a spec phase in auto mode could write anywhere in the repo."""
    set_config(".", _phase_config(PermissionConfig(mode=mode)))

    inside = check_path_permission(".devaccel/spec/prd.md", write=True)
    outside = check_path_permission("src/app.py", write=True)
    assert inside.allowed
    assert not outside.allowed


@pytest.mark.parametrize("mode", [MODE_MANUAL, MODE_AUTO])
def test_reads_are_never_fenced(mode):
    """A phase must be able to study the whole project while only being able
    to WRITE into its own output folder — that asymmetry is the point of
    allow_write_paths existing separately from allow_paths."""
    set_config(".", _phase_config(PermissionConfig(mode=mode)))
    assert check_path_permission("src/app.py", write=False).allowed


# ── Operator narrowing survives the phase too ────────────────────────────────

@pytest.mark.parametrize("mode", [MODE_MANUAL, MODE_AUTO])
def test_a_phase_cannot_widen_the_requests_tool_policy(mode):
    """`replace()` keeps allow_tools/deny_tools; building a fresh config threw
    them away, so a request that denied run_terminal got it back the moment a
    spec phase started."""
    request = PermissionConfig(mode=mode, deny_tools={"run_terminal"})
    set_config(".", _phase_config(request))
    assert not check_tool_permission("run_terminal", arguments={"command": "ls"}).allowed


def test_the_phase_fence_does_not_leak_back_into_the_request_config():
    """`replace()` returns a NEW config. If it mutated the request's own, the
    fence would still be in force after the workflow handed control back to
    the normal agent loop, and ordinary edits would start failing."""
    request = PermissionConfig(mode=MODE_MANUAL)
    _phase_config(request)
    assert request.allow_write_paths == []


def test_the_workflow_really_layers_the_fence():
    """Everything above tests `_phase_config`, which is this file's model of
    what SpecWorkflow does. That is worth nothing if the workflow stopped
    doing it — the "correct helper beside code that never calls it" gap. So
    check the real source: the phase config must be derived from
    base_permission_config, and must not construct a fresh one with a
    hard-coded mode.
    """
    import inspect

    from spec_driven.workflow import SpecWorkflow

    source = inspect.getsource(SpecWorkflow)
    phase_setup = source.split("allow_write_paths=list(phase.allow_write_paths)", 1)[0]
    tail = phase_setup[-400:]
    assert "replace(" in tail and "self.base_permission_config" in tail, (
        "the phase config is no longer derived from the request's own config"
    )
    # Comments are stripped before this check: the comment above the fix
    # QUOTES the old `mode="auto"` to explain what went wrong, and matching
    # that would make the test fail on the very documentation that prevents
    # the regression.
    code_only = "\n".join(
        line for line in source.splitlines()
        if not line.lstrip().startswith("#")
    )
    assert 'mode="auto"' not in code_only, (
        "a hard-coded auto mode is back — spec runs would ignore the user's "
        "choice and never prompt"
    )


def test_execution_phase_uses_the_request_config_unchanged():
    """Execution deliberately has NO fence — it writes wherever the approved
    tasks demand. It must therefore run under exactly the user's mode."""
    request = PermissionConfig(mode=MODE_MANUAL)
    set_config(".", request)
    assert check_path_permission("src/app.py", write=True).allowed
    assert check_tool_permission("code_edit", arguments={"file_path": "src/app.py"}).ask
