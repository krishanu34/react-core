-- ============================================================================
-- 004_agent_context.sql — per-agent checkpoints for crash/restart resume.
--
-- WHY A NEW TABLE (rather than reusing run_states):
--   run_states is `tracking_id PRIMARY KEY` — exactly ONE row per workspace.
--   That is fine for the single top-level run it was built for, but a fan-out
--   has a parent plus N sub-agents in flight at once, each with its own
--   message list and progress. They need their own rows, keyed by agent.
--
-- WHY THE DB AT ALL (files already hold checkpoints):
--   .devaccel/{thread}/tmp/ lives on the backend pod's EPHEMERAL disk. A pod
--   restart destroys it, and with >1 replica a resume request can land on a
--   pod that never had the files. Files are the fast in-run cache; this table
--   is the durable record that survives both.
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_checkpoints (
    id               BIGSERIAL PRIMARY KEY,
    tracking_id      TEXT NOT NULL REFERENCES workspaces(tracking_id) ON DELETE CASCADE,
    thread_id        TEXT NOT NULL,
    -- Identifies one agent within a run. The top-level agent uses '__root__';
    -- children use the id SubAgentTool generates (e.g. 'api-builder-3f9a21').
    agent_id         TEXT NOT NULL,
    -- NULL for the root agent; the spawning agent's id for children. This is
    -- what lets a resume re-run only the UNFINISHED branches of a fan-out.
    parent_agent_id  TEXT,
    role             TEXT,
    task             TEXT,
    -- running | done | unverified | stopped | failed
    status           TEXT NOT NULL,
    -- The agent's message list, with spill pointers rather than inlined blobs
    -- (see context/context_spill.py) so a row stays small.
    messages_json    JSONB NOT NULL,
    usage            JSONB NOT NULL DEFAULT '{}'::jsonb,
    steps_taken      INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (thread_id, agent_id)
);

-- Resume reads "the newest checkpoints for this thread".
CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_thread
    ON agent_checkpoints(thread_id, updated_at DESC);

-- Walking a fan-out's children when deciding what still needs re-running.
CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_parent
    ON agent_checkpoints(thread_id, parent_agent_id);
