"""
Two permission modes, and what each one gates.

The behaviour these tests pin down is the answer to "the agent edited my code
without asking" and to its opposite, "it asks me about everything". Both are
mode bugs, and both were reachable before: the default was `auto`, and the
ask-set was a list of tool NAMES that could not tell a README write from an
.env write.
"""

import pytest

from context.permissions import (
    MODE_AUTO,
    MODE_MANUAL,
    PermissionConfig,
    approve_all_for_session,
    approve_for_session,
    check_tool_permission,
    clear_session_approvals,
    default_mode,
    is_read_only_tool,
    is_session_approved,
    normalize_mode,
    set_config,
)


@pytest.fixture(autouse=True)
def _isolate():
    yield
    clear_session_approvals("t1")
    clear_session_approvals("t1::sub::a")


def manual():
    set_config(".", PermissionConfig(mode=MODE_MANUAL))


def auto():
    set_config(".", PermissionConfig(mode=MODE_AUTO))


# ── Mode normalisation ───────────────────────────────────────────────────────

@pytest.mark.parametrize("given,expected", [
    ("manual", MODE_MANUAL),
    ("auto", MODE_AUTO),
    ("AUTO", MODE_AUTO),
    ("  Manual  ", MODE_MANUAL),
    # Retired names still arrive from stale clients and old .env files.
    ("ask", MODE_MANUAL),
    ("standard", MODE_MANUAL),
    ("strict", MODE_MANUAL),
    # Anything unrecognised must fail CLOSED. A typo that silently disabled
    # every approval prompt is the one outcome there is no recovering from.
    ("stcrit", MODE_MANUAL),
    ("", MODE_MANUAL),
    (None, MODE_MANUAL),
])
def test_normalize_mode(given, expected):
    assert normalize_mode(given) == expected


def test_default_is_manual(monkeypatch):
    monkeypatch.delenv("PERMISSION_MODE", raising=False)
    assert default_mode() == MODE_MANUAL


def test_config_normalises_on_construction():
    """Every read path sees a live mode, so no call site has to translate."""
    assert PermissionConfig(mode="strict").mode == MODE_MANUAL


# ── Manual mode: what runs, what asks ────────────────────────────────────────

@pytest.mark.parametrize("tool", [
    "read_file", "batch_read_files", "grep_search", "file_search",
    "list_directory", "workspace_tree", "project_context", "web_search",
])
def test_reads_run_free_in_manual(tool):
    manual()
    r = check_tool_permission(tool, arguments={"path": "src/app.py"})
    assert r.allowed and not r.ask


@pytest.mark.parametrize("tool", [
    "file_write", "code_edit", "notebook_edit", "create_output",
    "run_terminal", "git",
])
def test_changes_ask_in_manual(tool):
    manual()
    r = check_tool_permission(tool, arguments={"path": "src/app.py"})
    assert not r.allowed and r.ask


def test_an_unknown_tool_asks():
    """The ask-set is INVERTED — read-only tools are listed, everything else
    asks — so a tool added next month is gated by default. Listing the
    mutating tools instead would leave a new one silently ungated, and that
    failure is invisible until it has already written something."""
    manual()
    assert not is_read_only_tool("some_tool_invented_next_year")
    r = check_tool_permission("some_tool_invented_next_year", arguments={})
    assert r.ask


def test_checkpoint_and_ask_user_are_never_gated():
    """Gating these deadlocks the flow they belong to: checkpoint IS the undo
    snapshot taken before an edit, and ask_user is how the agent reaches the
    human in the first place."""
    manual()
    assert check_tool_permission("checkpoint", arguments={}).allowed
    assert check_tool_permission("ask_user", arguments={}).allowed


# ── Argument-aware gating ────────────────────────────────────────────────────

@pytest.mark.parametrize("tool,args,category", [
    ("file_write",   {"path": "backend/.env"},                    "secrets"),
    ("code_edit",    {"file_path": "db/migrations/003_add.sql"},  "database"),
    ("file_write",   {"path": ".github/workflows/deploy.yml"},    "infrastructure"),
    ("run_terminal", {"command": "alembic upgrade head"},         "database"),
    ("run_terminal", {"command": "pip install requests"},         "dependencies"),
    ("run_terminal", {"command": "terraform apply -auto-approve"}, "infrastructure"),
    ("git",          {"command": "git push origin main"},         "vcs_publish"),
])
def test_high_impact_calls_are_labelled(tool, args, category):
    """The card has to say what is at stake. A prompt that reads only
    'run_terminal' trains people to approve without looking, which is worse
    than not prompting at all."""
    manual()
    r = check_tool_permission(tool, arguments=args)
    assert r.ask and r.category == category
    assert category.split("_")[0] in r.reason or r.reason


@pytest.mark.parametrize("args", [
    {"path": "README.md"},
    {"path": ".env.example"},          # a template exists to be edited
    {"path": "config/settings.sample.yaml"},
])
def test_ordinary_writes_ask_without_a_category(args):
    manual()
    r = check_tool_permission("file_write", arguments=args)
    assert r.ask and r.category == ""


@pytest.mark.parametrize("args", [
    {"path": ".env"},
    {"path": "migrations/0001_init.sql"},
    {"paths": [".env", "src/app.py"]},
])
def test_reading_a_sensitive_path_does_not_prompt(args):
    """Reading .env is how the agent learns the project's shape, and secret
    VALUES are redacted on the way out (tools/sensitive_guard.py). Prompting
    here would be friction with no safety gained."""
    manual()
    assert check_tool_permission("read_file", arguments=args).allowed


def test_a_command_hidden_in_a_read_only_tool_still_asks():
    """The case tool-name gating cannot see: something that only READS
    according to its name, handed an argument that EXECUTES."""
    manual()
    r = check_tool_permission("web_search", arguments={"command": "kubectl delete ns prod"})
    assert r.ask and r.category == "infrastructure"


# ── Auto mode ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("tool,args", [
    ("file_write", {"path": ".env"}),
    ("run_terminal", {"command": "terraform apply"}),
    ("code_edit", {"file_path": "migrations/1.sql"}),
])
def test_auto_gates_nothing(tool, args):
    auto()
    r = check_tool_permission(tool, arguments=args)
    assert r.allowed and not r.ask


def test_operator_narrowing_survives_auto_mode():
    """allow_tools/deny_tools are least-privilege POLICY, not a prompting
    preference. A custom agent narrowed to three tools must stay narrowed
    whichever mode the user picked, or picking auto would silently widen
    every persona in the workspace."""
    set_config(".", PermissionConfig(mode=MODE_AUTO, allow_tools={"read_file"}))
    assert check_tool_permission("read_file", arguments={}).allowed
    assert not check_tool_permission("run_terminal", arguments={}).allowed

    set_config(".", PermissionConfig(mode=MODE_AUTO, deny_tools={"run_terminal"}))
    assert not check_tool_permission("run_terminal", arguments={}).allowed


@pytest.mark.parametrize("tool", ["ask_user", "submit_plan", "skill", "checkpoint"])
def test_an_allow_list_cannot_decapitate_the_run(tool):
    """A whitelist should narrow capability, not remove the machinery the
    agent needs to consult the user or protect their work.

    This is a real failure, not a hypothetical one: our own chat UI sent its
    hand-maintained tool list as allow_tools, and every tool missing from it —
    `skill` among them — was denied before the agent could take a step. A
    client can never enumerate the server's registry, and MCP servers add
    tools at runtime, so any client-sent whitelist is incomplete by
    construction. These four cannot change the user's project, so blocking
    them buys no safety.
    """
    set_config(".", PermissionConfig(mode=MODE_MANUAL, allow_tools={"read_file"}))
    assert check_tool_permission(tool, arguments={}).allowed


@pytest.mark.parametrize("tool", ["file_write", "run_terminal", "restore_context",
                                  "resume_agent", "git"])
def test_the_exemption_does_not_leak_to_mutating_tools(tool):
    """The exemption is narrow on purpose. Anything that can change the
    project stays subject to the allow list — otherwise the list would mean
    nothing."""
    set_config(".", PermissionConfig(mode=MODE_MANUAL, allow_tools={"read_file"}))
    r = check_tool_permission(tool, arguments={})
    assert not r.allowed and not r.ask


@pytest.mark.parametrize("tool", ["ask_user", "skill", "checkpoint", "submit_plan"])
def test_deny_tools_still_beats_the_exemption(tool):
    """Exempt from the allow LIST, never from an explicit block. An operator
    who names a tool means it."""
    set_config(".", PermissionConfig(mode=MODE_MANUAL, deny_tools={tool}))
    assert not check_tool_permission(tool, arguments={}).allowed


def test_policy_denial_is_a_hard_block_not_a_prompt():
    """There is no human answer that should override configured least
    privilege, so a policy denial must never surface as an approval card."""
    set_config(".", PermissionConfig(mode=MODE_MANUAL, deny_tools={"run_terminal"}))
    r = check_tool_permission("run_terminal", arguments={"command": "ls"})
    assert not r.allowed and not r.ask


# ── Session approval ─────────────────────────────────────────────────────────

def test_session_grant_is_a_blanket():
    """'Allow for this session' has to end the interruptions, not move them
    to the next tool — otherwise a long build still stops twenty more times
    and the button has not solved the user's problem."""
    approve_all_for_session("t1")
    assert is_session_approved("t1", "file_write")
    assert is_session_approved("t1", "run_terminal")
    assert is_session_approved("t1", "anything_at_all")


def test_per_tool_grant_stays_per_tool():
    approve_for_session("t1", "file_write")
    assert is_session_approved("t1", "file_write")
    assert not is_session_approved("t1", "run_terminal")


def test_a_grant_reaches_sub_agents():
    """Approvals are keyed by ROOT thread. A sub-agent spawned after the user
    said yes must honour that yes: re-prompting for work already approved is
    how a fan-out turns one decision into fifteen."""
    approve_all_for_session("t1")
    assert is_session_approved("t1::sub::a", "file_write")
    assert is_session_approved("t1::sub::a::sub::b", "code_edit")


def test_clearing_a_child_does_not_wipe_the_conversation():
    """Regression: cleanup used to clear approvals under the CHILD's derived
    id. With root keying that would erase the human's own grant the moment
    the first sub-agent finished, and prompts would resume mid-task."""
    approve_all_for_session("t1")
    clear_session_approvals("t1::sub::a")
    # Same underlying key, so this is genuinely destructive — which is exactly
    # why sub_agent_tool no longer calls it.
    assert not is_session_approved("t1", "file_write")
