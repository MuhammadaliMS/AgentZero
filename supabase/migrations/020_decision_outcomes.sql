-- ============================================================================
-- Migration 020: Decision Outcome Tracking
-- ============================================================================
-- Tracks whether each decision's prediction was correct. Feeds accuracy data
-- back into agent prompts via working memory.
--
-- Evaluation methods:
--   auto_step_result    — Step completed/failed → immediate evaluation
--   auto_outcome_status — Outcome status after 24h
--   auto_ttl_expired    — Deferred item: did signal reappear?
--   auto_signal_recheck — Dismissed signal: did it come back?
--   manual              — Human override

CREATE TABLE IF NOT EXISTS decision_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES chief_loop_leases(id) ON DELETE SET NULL,

  -- Decision context
  decision_type TEXT NOT NULL,
  decision_payload JSONB NOT NULL DEFAULT '{}',
  decision_rationale TEXT,
  risk_score REAL,

  -- Prediction (from Feature 8's expected_outcome)
  prediction TEXT,
  prediction_confidence REAL,

  -- Target tracking
  target_type TEXT,    -- 'outcome', 'step', 'signal', 'entity'
  target_id TEXT,

  -- Evaluation result (NULL until evaluated)
  actual_result TEXT,
  accuracy_score REAL,   -- 0.0 = completely wrong, 1.0 = perfectly correct
  evaluated_at TIMESTAMPTZ,
  evaluation_method TEXT CHECK (evaluation_method IN (
    'auto_step_result', 'auto_outcome_status', 'auto_ttl_expired',
    'auto_signal_recheck', 'manual'
  )),

  -- When to auto-evaluate
  evaluate_after TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index: pending evaluations (most frequent query)
CREATE INDEX IF NOT EXISTS idx_do_pending_eval
  ON decision_outcomes(org_id, evaluate_after)
  WHERE accuracy_score IS NULL;

-- Index: per-type aggregation
CREATE INDEX IF NOT EXISTS idx_do_org_type
  ON decision_outcomes(org_id, decision_type);

-- Index: target lookup (for outcome/step status checks)
CREATE INDEX IF NOT EXISTS idx_do_target
  ON decision_outcomes(target_type, target_id)
  WHERE accuracy_score IS NULL;

-- RLS: service-role only (chief loop runs as admin)
ALTER TABLE decision_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY decision_outcomes_service
  ON decision_outcomes FOR ALL
  USING (true) WITH CHECK (true);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_decision_outcomes_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_decision_outcomes_updated_at
  BEFORE UPDATE ON decision_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION update_decision_outcomes_updated_at();
