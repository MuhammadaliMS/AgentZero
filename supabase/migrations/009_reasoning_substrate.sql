-- ============================================================================
-- Migration 009: Reasoning Substrate
--
-- Phase A of Chief-of-Staff Agent V1 — LLM-First, High-Agency Runtime.
--
-- Introduces DecisionCards: structured reasoning artifacts that capture
-- the agent's decision-making per major turn/trigger. These make LLM
-- reasoning transparent, auditable, and feed the learning loop.
-- ============================================================================

-- ─── Decision Cards ──────────────────────────────────────────────────────────

CREATE TABLE decision_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  conversation_id UUID,
  -- outcome_id will be added in Phase B (Outcome Runtime)

  -- Trigger context
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'user_turn',          -- Major user-facing decision during chat
    'proactive_signal',   -- Ghost agent or patrol trigger
    'contradiction',      -- Contradiction detected/resolved
    'planning',           -- Multi-step plan formulation
    'escalation',         -- Risk escalation or priority shift
    'recovery'            -- Failure recovery / replanning
  )),
  trigger_source TEXT,    -- e.g. 'chat', 'ghost_agent', 'patrol', 'brief'

  -- Core reasoning
  objective TEXT NOT NULL,                    -- What we're trying to achieve
  context_summary TEXT,                       -- Relevant background
  hypotheses JSONB DEFAULT '[]',             -- Array of { hypothesis, evidence, confidence }
  options_considered JSONB DEFAULT '[]',     -- Array of { option, pros, cons, rejected_reason? }
  chosen_action TEXT NOT NULL,               -- What was decided
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  why_now TEXT,                              -- Why this decision matters at this moment
  risk_notes TEXT,                           -- Known risks with this choice

  -- Linkage
  related_entity_ids UUID[] NOT NULL DEFAULT '{}',
  related_insight_ids UUID[] NOT NULL DEFAULT '{}',

  -- Metadata
  model_used TEXT,                           -- Which LLM model produced this
  reasoning_tokens INTEGER,                  -- Tokens spent on reasoning (if available)
  latency_ms INTEGER,                        -- Time to produce the card

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX idx_dc_org_conversation ON decision_cards(org_id, conversation_id);
CREATE INDEX idx_dc_org_created ON decision_cards(org_id, created_at DESC);
CREATE INDEX idx_dc_trigger ON decision_cards(org_id, trigger_type);
CREATE INDEX idx_dc_entities ON decision_cards USING GIN (related_entity_ids);

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE decision_cards ENABLE ROW LEVEL SECURITY;

-- Org members can view decision cards
CREATE POLICY dc_select_org ON decision_cards FOR SELECT USING (
  org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
);

-- Service role can do everything (agent writes cards)
CREATE POLICY dc_service_all ON decision_cards FOR ALL USING (
  (SELECT current_setting('request.jwt.claims', true)::json->>'role') = 'service_role'
);

-- ─── Helper: bump_decision_card_count ────────────────────────────────────────
-- Optional: track how many decision cards exist per conversation (for metrics)

CREATE OR REPLACE FUNCTION get_decision_cards_for_conversation(
  p_org_id UUID,
  p_conversation_id UUID,
  p_limit INTEGER DEFAULT 20
)
RETURNS SETOF decision_cards
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM decision_cards
  WHERE org_id = p_org_id
    AND conversation_id = p_conversation_id
  ORDER BY created_at DESC
  LIMIT p_limit;
$$;
