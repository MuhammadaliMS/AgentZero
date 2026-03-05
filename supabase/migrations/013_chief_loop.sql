-- ============================================================================
-- Migration 013: Chief Loop — Unified hourly intelligence + execution runtime
-- ============================================================================
-- Adds tables and columns for the chief-loop orchestrator that merges
-- ghost-agent intelligence with outcome execution into a single closed loop.

-- ─── New Table: chief_loop_leases ──────────────────────────────────────────
-- Active lease semantics for org-level hourly lock.
-- Prevents concurrent runs; auto-expires after 55 minutes.

CREATE TABLE chief_loop_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  result_summary TEXT,
  error TEXT,
  signals_ingested INTEGER DEFAULT 0,
  outcomes_created INTEGER DEFAULT 0,
  steps_executed INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0
);

-- Partial index: fast lookup for active leases per org
CREATE INDEX idx_cll_active ON chief_loop_leases(org_id, status)
  WHERE status = 'running';

-- History index: recent leases per org
CREATE INDEX idx_cll_org ON chief_loop_leases(org_id, acquired_at DESC);

-- RLS: service_role only
ALTER TABLE chief_loop_leases ENABLE ROW LEVEL SECURITY;


-- ─── New Table: chief_loop_events ──────────────────────────────────────────
-- Decision audit log. Every decision the chief loop makes is recorded here
-- with rationale and policy gate results for auditability and replay.

CREATE TABLE chief_loop_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES chief_loop_leases(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  -- event_type values:
  --   signal_ingested, signal_attached_to_outcome, outcome_replanned,
  --   outcome_auto_created, step_executed, step_blocked, blocker_asked,
  --   blocker_escalated, budget_deferred, decision_made, chief_loop_completed
  target_type TEXT,        -- 'outcome', 'step', 'insight', 'finding'
  target_id TEXT,
  rationale TEXT,
  policy_result TEXT,      -- 'allowed', 'blocked_by_policy', 'deferred'
  policy_reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_cle_org ON chief_loop_events(org_id, created_at DESC);
CREATE INDEX idx_cle_lease ON chief_loop_events(lease_id);
CREATE INDEX idx_cle_type ON chief_loop_events(event_type);

ALTER TABLE chief_loop_events ENABLE ROW LEVEL SECURITY;


-- ─── New Table: outcome_signal_links ───────────────────────────────────────
-- Links signals (findings, insights, messages, emails) to outcomes.
-- Enables tracing why an outcome was created and what evidence supports it.

CREATE TABLE outcome_signal_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outcome_id UUID NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
  run_id UUID REFERENCES outcome_runs(id) ON DELETE SET NULL,
  signal_type TEXT NOT NULL,    -- 'finding', 'insight', 'message', 'email'
  signal_id TEXT NOT NULL,      -- UUID or external ref
  link_type TEXT NOT NULL DEFAULT 'evidence'
    CHECK (link_type IN ('trigger', 'evidence', 'contradiction', 'resolution')),
  linked_by TEXT NOT NULL DEFAULT 'chief_loop',  -- 'chief_loop', 'user', 'patrol'
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(outcome_id, signal_type, signal_id)
);

CREATE INDEX idx_osl_outcome ON outcome_signal_links(outcome_id);
CREATE INDEX idx_osl_signal ON outcome_signal_links(signal_type, signal_id);

ALTER TABLE outcome_signal_links ENABLE ROW LEVEL SECURITY;


-- ─── Column Additions: outcome_runs ────────────────────────────────────────
-- Track which run this supersedes and what triggered the replan.

ALTER TABLE outcome_runs
  ADD COLUMN IF NOT EXISTS supersedes_run_id UUID REFERENCES outcome_runs(id);

ALTER TABLE outcome_runs
  ADD COLUMN IF NOT EXISTS trigger_source TEXT DEFAULT 'user';
  -- Values: 'user', 'chief_loop', 'patrol', 'conversation'


-- ─── Column Additions: outcome_steps ───────────────────────────────────────
-- Track step origin (who created it) and risk class (auto-exec vs approval).

ALTER TABLE outcome_steps
  ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT 'user_plan';
  -- Values: 'user_plan', 'auto_replan', 'auto_created', 'chief_loop'

ALTER TABLE outcome_steps
  ADD COLUMN IF NOT EXISTS risk_class TEXT DEFAULT 'internal';
  -- Values: 'internal' (auto-executable), 'external' (needs approval)


-- ─── Column Additions: worker_executions ───────────────────────────────────
-- Track which loop phase and lease this execution belongs to.

ALTER TABLE worker_executions
  ADD COLUMN IF NOT EXISTS loop_phase TEXT;

ALTER TABLE worker_executions
  ADD COLUMN IF NOT EXISTS lease_id UUID;
