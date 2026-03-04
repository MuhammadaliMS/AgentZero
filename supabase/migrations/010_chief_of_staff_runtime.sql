-- ============================================================================
-- Migration 010: Chief-of-Staff Runtime — Phases B through F
--
-- Phase B: Outcome-Centric Runtime (outcomes, runs, steps)
-- Phase C: Proactive Intervention Engine (triage, feedback)
-- Phase D: Strategic Memory Layer (narratives, curation log)
-- Phase E: Learning Loop (outcome impact, user preferences, weekly tuning)
-- Phase F: Rollout Management (org rollout mode, measurement)
-- ============================================================================


-- ============================================================
-- PHASE B: Outcome-Centric Runtime
-- ============================================================

-- ─── B1. outcomes — Top-level unit of work ──────────────────

CREATE TABLE outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,

  -- Goal description
  title TEXT NOT NULL,
  description TEXT,
  goal_type TEXT NOT NULL DEFAULT 'user_request' CHECK (goal_type IN (
    'user_request',        -- Direct user instruction
    'proactive_signal',    -- Ghost agent / patrol triggered
    'follow_up',           -- Continuation of prior outcome
    'scheduled'            -- Cron / calendar triggered
  )),

  -- Status lifecycle
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN (
    'planning',            -- LLM is formulating plan
    'executing',           -- Steps are being run
    'blocked',             -- Waiting for human input or approval
    'completed',           -- All steps done successfully
    'failed',              -- Unrecoverable failure
    'cancelled'            -- User or system cancelled
  )),

  -- Ownership
  owner_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,

  -- Linkage
  parent_outcome_id UUID REFERENCES outcomes(id) ON DELETE SET NULL,
  related_entity_ids UUID[] NOT NULL DEFAULT '{}',

  -- Metadata
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  confidence REAL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  blocker_summary TEXT,              -- Current blocker in plain language (if blocked)

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outcomes_org_status ON outcomes(org_id, status);
CREATE INDEX idx_outcomes_org_created ON outcomes(org_id, created_at DESC);
CREATE INDEX idx_outcomes_owner ON outcomes(owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_outcomes_parent ON outcomes(parent_outcome_id) WHERE parent_outcome_id IS NOT NULL;
CREATE INDEX idx_outcomes_entities ON outcomes USING GIN (related_entity_ids);

-- ─── B2. outcome_runs — Plan versions per outcome ───────────

CREATE TABLE outcome_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  outcome_id UUID NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,

  -- Plan versioning
  plan_version INTEGER NOT NULL DEFAULT 1,
  plan_summary TEXT,                -- LLM's one-liner for this plan version
  replan_reason TEXT,               -- Why we re-planned (null for v1)

  -- Status
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active',              -- Currently executing
    'completed',           -- All steps done
    'superseded',          -- New run replaced this one
    'failed'               -- Unrecoverable failure
  )),

  -- Linkage
  decision_card_id UUID REFERENCES decision_cards(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_runs_outcome ON outcome_runs(outcome_id, plan_version);
CREATE INDEX idx_runs_org_status ON outcome_runs(org_id) WHERE status = 'active';

-- ─── B2.5 pending_approvals — Must exist before outcome_steps FK ─────────
-- Moved here from migration 011 because outcome_steps.approval_id references
-- pending_approvals(approval_id). Creating it in the same migration avoids
-- FK errors when migrations run sequentially.

CREATE TABLE IF NOT EXISTS pending_approvals (
  approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_input JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '2 minutes'
);

CREATE INDEX IF NOT EXISTS idx_pa_conversation
  ON pending_approvals(conversation_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pa_expires
  ON pending_approvals(expires_at)
  WHERE status = 'pending';

ALTER TABLE pending_approvals ENABLE ROW LEVEL SECURITY;

-- Service role only: RLS is enabled with ZERO policies.
-- service_role bypasses RLS entirely, so no policy = locked to service_role.
-- Authenticated users have no access (correct: internal system table).


-- ─── B3. outcome_steps — Individual actions within a run ────

CREATE TABLE outcome_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES outcome_runs(id) ON DELETE CASCADE,

  -- Ordering and dependencies
  step_order INTEGER NOT NULL,
  depends_on UUID[] NOT NULL DEFAULT '{}',    -- Step IDs this depends on

  -- What to do
  action_type TEXT NOT NULL CHECK (action_type IN (
    'tool_call',           -- Execute a specific tool
    'llm_reasoning',       -- LLM needs to think/decide
    'wait_input',          -- Waiting for user input
    'wait_approval',       -- Waiting for user approval
    'wait_dependency',     -- Waiting for external dependency
    'composite'            -- Contains sub-steps (for grouping)
  )),
  description TEXT NOT NULL,          -- Human-readable step description
  tool_name TEXT,                     -- If action_type='tool_call'
  tool_args JSONB,                    -- Planned tool arguments
  expected_output TEXT,               -- What we expect to get

  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',             -- Not yet started
    'executing',           -- In progress
    'blocked',             -- Waiting for something
    'completed',           -- Done successfully
    'failed',              -- Failed (may retry or replan)
    'skipped'              -- Skipped (dependency failed, user cancelled)
  )),

  -- Blocker info (when status='blocked')
  blocker_type TEXT CHECK (blocker_type IN (
    'input_needed',        -- Need user input
    'approval_pending',    -- Need user approval
    'dependency',          -- External dependency not met
    'tool_failure'         -- Tool call failed, needs resolution
  )),
  one_clear_ask TEXT,                 -- THE one question to unblock

  -- Result
  result_summary TEXT,                -- What actually happened
  result_data JSONB,                  -- Structured result
  error_message TEXT,                 -- If failed

  -- Linkage
  decision_card_id UUID REFERENCES decision_cards(id) ON DELETE SET NULL,
  approval_id UUID REFERENCES pending_approvals(approval_id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_steps_run ON outcome_steps(run_id, step_order);
CREATE INDEX idx_steps_status ON outcome_steps(run_id) WHERE status IN ('pending', 'executing', 'blocked');

-- Add outcome_id column to decision_cards (anticipated in migration 009)
ALTER TABLE decision_cards
  ADD COLUMN IF NOT EXISTS outcome_id UUID REFERENCES outcomes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES outcome_runs(id) ON DELETE SET NULL;

CREATE INDEX idx_dc_outcome ON decision_cards(outcome_id) WHERE outcome_id IS NOT NULL;


-- ============================================================
-- PHASE C: Proactive Intervention Engine
-- ============================================================

-- ─── C1. intervention_triage — LLM triage decisions ─────────

CREATE TABLE intervention_triage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Source
  source_type TEXT NOT NULL CHECK (source_type IN (
    'patrol_finding', 'graph_insight', 'calendar_event',
    'deadline', 'stale_blocker', 'integration_event', 'outcome_blocked'
  )),
  source_id UUID,                    -- ID of the source record
  source_summary TEXT NOT NULL,      -- What triggered this

  -- Triage decision
  triage_decision TEXT NOT NULL CHECK (triage_decision IN (
    'interrupt_now',       -- High-impact, time-sensitive
    'defer_brief',         -- Include in next brief
    'watch'                -- Track silently, mention if persists
  )),
  scoring_rationale TEXT,            -- LLM reasoning for triage
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),

  -- Why-now context
  user_impact TEXT,                  -- Estimated impact on user
  timing_sensitivity TEXT,           -- Why timing matters
  recommended_channel TEXT CHECK (recommended_channel IN (
    'chat', 'slack', 'brief', 'email'
  )),

  -- Routing
  routed_to TEXT,                    -- 'nudge', 'brief', 'none'
  finding_id UUID REFERENCES patrol_findings(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_triage_org_user ON intervention_triage(org_id, user_id, created_at DESC);
CREATE INDEX idx_triage_decision ON intervention_triage(org_id, triage_decision);

-- ─── C2. intervention_feedback — Anti-spam memory ───────────

CREATE TABLE intervention_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  triage_id UUID REFERENCES intervention_triage(id) ON DELETE SET NULL,

  -- What was proposed
  intervention_type TEXT NOT NULL,    -- e.g. 'deadline_reminder', 'vendor_alert'
  intervention_summary TEXT NOT NULL,

  -- User response
  user_response TEXT NOT NULL CHECK (user_response IN (
    'accepted',            -- User acted on it
    'deferred',            -- User deferred / "remind me later"
    'ignored',             -- No response within window
    'rejected'             -- User explicitly dismissed / "stop these"
  )),

  -- Context
  response_latency_ms INTEGER,       -- How fast user responded
  source_category TEXT,              -- Category for pattern learning

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);

CREATE INDEX idx_ifeedback_org_user ON intervention_feedback(org_id, user_id, created_at DESC);
CREATE INDEX idx_ifeedback_category ON intervention_feedback(org_id, source_category);


-- ============================================================
-- PHASE D: Strategic Memory Layer
-- ============================================================

-- ─── D1. strategic_narratives — Ongoing initiative context ──

CREATE TABLE strategic_narratives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- What this narrative covers
  title TEXT NOT NULL,
  narrative_type TEXT NOT NULL CHECK (narrative_type IN (
    'initiative',          -- Ongoing project/program
    'political_context',   -- Stakeholder dynamics
    'decision_thread',     -- Connected chain of decisions
    'risk_thread',         -- Evolving risk story
    'relationship_dynamic' -- How key people/teams interact
  )),

  -- Rich narrative content
  summary TEXT NOT NULL,             -- Current state summary
  key_facts JSONB NOT NULL DEFAULT '[]',       -- Array of { fact, source, confidence, timestamp }
  decision_history JSONB NOT NULL DEFAULT '[]', -- Array of { decision, date, outcome, lesson }
  prior_outcomes JSONB NOT NULL DEFAULT '[]',   -- Array of { outcome, impact, date }
  open_questions JSONB NOT NULL DEFAULT '[]',   -- Array of { question, context, priority }

  -- Linkage
  related_entity_ids UUID[] NOT NULL DEFAULT '{}',
  related_outcome_ids UUID[] NOT NULL DEFAULT '{}',

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'dormant', 'archived', 'pinned'
  )),
  promotion_score REAL NOT NULL DEFAULT 0.5,  -- Curator score (0-1)
  last_updated_by TEXT,              -- 'chat', 'brief', 'curator', 'manual'

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_narratives_org_status ON strategic_narratives(org_id) WHERE status = 'active';
CREATE INDEX idx_narratives_type ON strategic_narratives(org_id, narrative_type);
CREATE INDEX idx_narratives_entities ON strategic_narratives USING GIN (related_entity_ids);

-- ─── D2. memory_curation_log — Track curator decisions ──────

CREATE TABLE memory_curation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- What was curated
  target_type TEXT NOT NULL CHECK (target_type IN (
    'entity', 'memory', 'narrative', 'insight', 'relationship'
  )),
  target_id UUID NOT NULL,

  -- Curator action
  action TEXT NOT NULL CHECK (action IN (
    'promote',             -- Elevated importance
    'decay',               -- Reduced importance
    'reactivate',          -- Brought back from dormancy
    'merge',               -- Merged with another record
    'archive',             -- Moved to archive
    'pin',                 -- Made permanent
    'unpin',               -- Removed permanent status
    'update_narrative'     -- Updated narrative content
  )),
  score_before REAL,
  score_after REAL,
  rationale TEXT,                    -- LLM reasoning for action

  -- Who/what triggered
  triggered_by TEXT NOT NULL CHECK (triggered_by IN (
    'ghost_agent', 'chat', 'manual', 'decay_cycle', 'extraction'
  )),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_curation_org ON memory_curation_log(org_id, created_at DESC);
CREATE INDEX idx_curation_target ON memory_curation_log(target_type, target_id);


-- ============================================================
-- PHASE E: Learning Loop
-- ============================================================

-- ─── E1. outcome_impact — Track outcome → insight impact ────

CREATE TABLE outcome_impact (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Links
  outcome_id UUID NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
  insight_id UUID REFERENCES graph_insights(id) ON DELETE SET NULL,
  decision_card_id UUID REFERENCES decision_cards(id) ON DELETE SET NULL,
  entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,

  -- Impact measurement
  impact_type TEXT NOT NULL CHECK (impact_type IN (
    'insight_led_to_action',     -- Insight surfaced → user acted
    'decision_led_to_outcome',   -- Decision card → outcome resolved
    'context_improved_response', -- Injected context was useful
    'intervention_prevented_risk', -- Proactive intervention helped
    'false_positive'              -- Surfaced something useless
  )),
  impact_rating INTEGER CHECK (impact_rating BETWEEN 1 AND 5),  -- User-scored or inferred
  impact_notes TEXT,

  -- Timing
  action_taken_at TIMESTAMPTZ,
  outcome_achieved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_impact_org ON outcome_impact(org_id, created_at DESC);
CREATE INDEX idx_impact_outcome ON outcome_impact(outcome_id);
CREATE INDEX idx_impact_insight ON outcome_impact(insight_id) WHERE insight_id IS NOT NULL;

-- ─── E2. user_preferences — Learned personalization params ──

CREATE TABLE user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Intervention preferences
  intervention_timing TEXT NOT NULL DEFAULT 'moderate' CHECK (intervention_timing IN (
    'aggressive', 'moderate', 'conservative'
  )),
  -- Message style
  message_style TEXT NOT NULL DEFAULT 'brief' CHECK (message_style IN (
    'brief', 'detailed', 'analytical'
  )),
  -- Risk tolerance (0=very conservative, 1=very aggressive)
  risk_tolerance REAL NOT NULL DEFAULT 0.5 CHECK (risk_tolerance BETWEEN 0 AND 1),
  -- Escalation preference
  escalation_preference TEXT NOT NULL DEFAULT 'moderate' CHECK (escalation_preference IN (
    'escalate_early', 'moderate', 'escalate_late'
  )),

  -- Source of preferences
  source TEXT NOT NULL DEFAULT 'default' CHECK (source IN (
    'default',             -- System defaults
    'explicit',            -- User explicitly set
    'learned'              -- Inferred from behavior
  )),

  -- Learning metadata
  learned_at TIMESTAMPTZ DEFAULT now(),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  sample_size INTEGER NOT NULL DEFAULT 0,  -- How many interactions informed this

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_user_prefs UNIQUE (org_id, user_id)
);

CREATE INDEX idx_prefs_user ON user_preferences(user_id);

-- ─── E3. weekly_tuning_log — Bounded adaptive adjustments ───

CREATE TABLE weekly_tuning_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Tuning period
  tuning_week DATE NOT NULL,         -- Start of the week

  -- Analysis
  total_interactions INTEGER NOT NULL DEFAULT 0,
  acceptance_rate REAL,              -- % of recommendations accepted
  intervention_accuracy REAL,        -- % of interventions that were useful
  false_positive_rate REAL,          -- % of surfaces that were useless

  -- Proposals and results
  proposals JSONB NOT NULL DEFAULT '[]',       -- Array of proposed changes
  approved_changes JSONB NOT NULL DEFAULT '[]', -- Array of changes applied
  guardrail_violations JSONB NOT NULL DEFAULT '[]', -- Proposed changes blocked by guardrails

  -- Applied
  applied_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tuning_org_week ON weekly_tuning_log(org_id, tuning_week DESC);


-- ============================================================
-- PHASE F: Rollout Management
-- ============================================================

-- ─── F1. org_rollout_config — Per-org rollout mode ──────────

CREATE TABLE org_rollout_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Current mode
  rollout_mode TEXT NOT NULL DEFAULT 'shadow' CHECK (rollout_mode IN (
    'shadow',              -- Decision cards only, no actions
    'assisted',            -- Low-risk auto, medium/high needs approval
    'auto'                 -- Internal low-risk auto, external needs approval
  )),

  -- Expansion criteria
  min_acceptance_rate REAL NOT NULL DEFAULT 0.80,    -- Must be ≥ this to advance
  max_error_rate REAL NOT NULL DEFAULT 0.05,         -- Must be ≤ this to advance
  min_interactions INTEGER NOT NULL DEFAULT 40,       -- Minimum interactions before mode change

  -- Allowed autonomous action types (in auto mode)
  auto_allowed_actions TEXT[] NOT NULL DEFAULT ARRAY[
    'recall_memory', 'store_memory', 'query_entity_graph',
    'emit_decision_card', 'query_commitments', 'query_actions'
  ]::TEXT[],

  -- Mode history
  mode_changed_at TIMESTAMPTZ DEFAULT now(),
  mode_changed_reason TEXT,
  previous_mode TEXT,

  -- Phase 3a: Manual gate — must be explicitly set to true before advancing to auto
  manual_auto_approved BOOLEAN NOT NULL DEFAULT false,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_org_rollout UNIQUE (org_id)
);

-- ─── F2. rollout_measurement — Weekly measurement snapshots ─

CREATE TABLE rollout_measurement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Period
  measurement_week DATE NOT NULL,

  -- Core metrics
  total_outcomes INTEGER NOT NULL DEFAULT 0,
  completed_outcomes INTEGER NOT NULL DEFAULT 0,
  failed_outcomes INTEGER NOT NULL DEFAULT 0,
  total_decisions INTEGER NOT NULL DEFAULT 0,
  avg_decision_confidence REAL,

  -- Acceptance
  total_recommendations INTEGER NOT NULL DEFAULT 0,
  accepted_recommendations INTEGER NOT NULL DEFAULT 0,
  rejected_recommendations INTEGER NOT NULL DEFAULT 0,

  -- Error tracking
  total_actions INTEGER NOT NULL DEFAULT 0,
  successful_actions INTEGER NOT NULL DEFAULT 0,
  failed_actions INTEGER NOT NULL DEFAULT 0,

  -- User satisfaction (inferred)
  interventions_accepted INTEGER NOT NULL DEFAULT 0,
  interventions_ignored INTEGER NOT NULL DEFAULT 0,
  interventions_rejected INTEGER NOT NULL DEFAULT 0,
  escalation_count INTEGER NOT NULL DEFAULT 0,

  -- Computed scores
  acceptance_rate REAL,
  error_rate REAL,
  outcome_impact_score REAL,         -- Weighted average of outcome_impact ratings

  -- Rollout recommendation
  recommended_mode TEXT CHECK (recommended_mode IN ('shadow','assisted','auto')),
  recommendation_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_measurement_org_week ON rollout_measurement(org_id, measurement_week DESC);


-- ============================================================
-- RLS Policies
-- ============================================================

-- Outcomes
ALTER TABLE outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view outcomes"
  ON outcomes FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access outcomes"
  ON outcomes FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- Outcome runs
ALTER TABLE outcome_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view outcome runs"
  ON outcome_runs FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access outcome runs"
  ON outcome_runs FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- Outcome steps
ALTER TABLE outcome_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view outcome steps"
  ON outcome_steps FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access outcome steps"
  ON outcome_steps FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- Intervention triage
ALTER TABLE intervention_triage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view intervention triage"
  ON intervention_triage FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access intervention triage"
  ON intervention_triage FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- Intervention feedback
ALTER TABLE intervention_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view own intervention feedback"
  ON intervention_feedback FOR SELECT USING (
    user_id = auth.uid()
  );
CREATE POLICY "Service role full access intervention feedback"
  ON intervention_feedback FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- Strategic narratives
ALTER TABLE strategic_narratives ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view narratives"
  ON strategic_narratives FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access narratives"
  ON strategic_narratives FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- Memory curation log
ALTER TABLE memory_curation_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view curation log"
  ON memory_curation_log FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access curation log"
  ON memory_curation_log FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- Outcome impact
ALTER TABLE outcome_impact ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view outcome impact"
  ON outcome_impact FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access outcome impact"
  ON outcome_impact FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- User preferences
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own preferences"
  ON user_preferences FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can update own preferences"
  ON user_preferences FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "Service role full access user preferences"
  ON user_preferences FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- Weekly tuning log
ALTER TABLE weekly_tuning_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view tuning log"
  ON weekly_tuning_log FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access tuning log"
  ON weekly_tuning_log FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- Org rollout config
ALTER TABLE org_rollout_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view rollout config"
  ON org_rollout_config FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access rollout config"
  ON org_rollout_config FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- Rollout measurement
ALTER TABLE rollout_measurement ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Org members can view rollout measurement"
  ON rollout_measurement FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access rollout measurement"
  ON rollout_measurement FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );


-- ============================================================
-- RPC Functions
-- ============================================================

-- ─── Get active outcome for org ─────────────────────────────
CREATE OR REPLACE FUNCTION get_active_outcomes(
  p_org_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS SETOF outcomes
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM outcomes
  WHERE org_id = p_org_id
    AND status IN ('planning', 'executing', 'blocked')
  ORDER BY
    CASE priority
      WHEN 'critical' THEN 1
      WHEN 'high' THEN 2
      WHEN 'medium' THEN 3
      WHEN 'low' THEN 4
    END,
    created_at DESC
  LIMIT p_limit;
$$;

-- ─── Get intervention history for anti-spam ─────────────────
CREATE OR REPLACE FUNCTION get_intervention_history(
  p_org_id UUID,
  p_user_id UUID,
  p_source_category TEXT DEFAULT NULL,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  intervention_type TEXT,
  total_count BIGINT,
  accepted_count BIGINT,
  ignored_count BIGINT,
  rejected_count BIGINT,
  last_intervention_at TIMESTAMPTZ,
  acceptance_rate REAL
) AS $$
SELECT
  if_r.intervention_type,
  COUNT(*) AS total_count,
  COUNT(*) FILTER (WHERE if_r.user_response = 'accepted') AS accepted_count,
  COUNT(*) FILTER (WHERE if_r.user_response = 'ignored') AS ignored_count,
  COUNT(*) FILTER (WHERE if_r.user_response = 'rejected') AS rejected_count,
  MAX(if_r.created_at) AS last_intervention_at,
  CASE
    WHEN COUNT(*) = 0 THEN 0
    ELSE (COUNT(*) FILTER (WHERE if_r.user_response = 'accepted'))::REAL / COUNT(*)::REAL
  END AS acceptance_rate
FROM intervention_feedback if_r
WHERE if_r.org_id = p_org_id
  AND if_r.user_id = p_user_id
  AND if_r.created_at >= now() - (p_days || ' days')::interval
  AND (p_source_category IS NULL OR if_r.source_category = p_source_category)
GROUP BY if_r.intervention_type;
$$ LANGUAGE sql STABLE;

-- ─── Compute weekly rollout metrics ─────────────────────────
CREATE OR REPLACE FUNCTION compute_rollout_metrics(
  p_org_id UUID,
  p_week_start DATE
)
RETURNS TABLE (
  total_outcomes INTEGER,
  completed_outcomes INTEGER,
  failed_outcomes INTEGER,
  total_decisions INTEGER,
  avg_confidence REAL,
  acceptance_rate REAL,
  error_rate REAL
) AS $$
DECLARE
  v_week_end DATE := p_week_start + interval '7 days';
BEGIN
  RETURN QUERY
  WITH outcome_stats AS (
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed
    FROM outcomes
    WHERE org_id = p_org_id
      AND created_at >= p_week_start
      AND created_at < v_week_end
  ),
  decision_stats AS (
    SELECT
      COUNT(*) AS total,
      AVG(confidence) AS avg_conf
    FROM decision_cards
    WHERE org_id = p_org_id
      AND created_at >= p_week_start
      AND created_at < v_week_end
  ),
  intervention_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE user_response = 'accepted') AS accepted,
      COUNT(*) FILTER (WHERE user_response = 'rejected') AS rejected,
      COUNT(*) AS total
    FROM intervention_feedback
    WHERE org_id = p_org_id
      AND created_at >= p_week_start
      AND created_at < v_week_end
  ),
  step_stats AS (
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed
    FROM outcome_steps os
    JOIN outcome_runs r ON r.id = os.run_id
    WHERE r.org_id = p_org_id
      AND os.created_at >= p_week_start
      AND os.created_at < v_week_end
  )
  SELECT
    o.total::INTEGER,
    o.completed::INTEGER,
    o.failed::INTEGER,
    d.total::INTEGER,
    d.avg_conf::REAL,
    CASE WHEN i.total = 0 THEN NULL
      ELSE (i.accepted::REAL / i.total::REAL)
    END,
    CASE WHEN s.total = 0 THEN NULL
      ELSE (s.failed::REAL / s.total::REAL)
    END
  FROM outcome_stats o, decision_stats d, intervention_stats i, step_stats s;
END;
$$ LANGUAGE plpgsql STABLE;
