"""
Thread identity — the difference between a thread's STATE and its CHANNEL.

A sub-agent runs under a derived thread id:

    {root}::sub::{agent_id}

That derivation is deliberate and load-bearing for STATE: it gives each child
its own read-before-overwrite tracker, task list and permission approvals, so
siblings in a fan-out cannot authorise each other's writes.

It is wrong for CHANNELS. Anything the BROWSER answers — a delegated tool
result, a permission decision, a spec gate — is POSTed under the thread id the
client opened its SSE stream with, which is always the root. A child that
registered its future under the derived id is waiting on a key nothing will
ever resolve, so the call hangs to its timeout and then fails: a delegated tool
reports an error, and an approval request times out into a denial.

Hence one rule, in one place: state uses `thread_id`, channels use
`root_thread_id(thread_id)`.
"""

# Separator used when SubAgentTool derives a child's thread id. Defined here so
# the code that BUILDS the id and the code that UNDOES it cannot drift apart.
SUB_SEPARATOR = "::sub::"


def root_thread_id(thread_id: str) -> str:
    """The conversation's own thread id — what the client knows and answers to.

    Nested spawns produce "root::sub::a::sub::b"; splitting on the FIRST
    separator therefore returns the root from any depth, not just one level up.
    A plain thread id is returned unchanged.
    """
    if not thread_id:
        return thread_id
    return thread_id.split(SUB_SEPARATOR, 1)[0]


def is_subagent_thread(thread_id: str) -> bool:
    return SUB_SEPARATOR in (thread_id or "")
