-- ============================================================================
-- Migration 019: Risk Scoring — Tiered approval based on risk score
-- ============================================================================
-- Three tiers: AUTO (risk < 0.3), NOTIFY (0.3-0.7), APPROVAL (> 0.7).
-- External tools always floor at 0.7 regardless of LLM-assigned score.

-- Add risk_score to outcome_steps (coexists with existing risk_class)
ALTER TABLE outcome_steps
  ADD COLUMN IF NOT EXISTS risk_score REAL;

-- Add risk_score to chief_loop_events (audit trail)
ALTER TABLE chief_loop_events
  ADD COLUMN IF NOT EXISTS risk_score REAL;

-- Extend pending_approvals for chief loop context
ALTER TABLE pending_approvals
  ADD COLUMN IF NOT EXISTS risk_score REAL,
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS decision_type TEXT,
  ADD COLUMN IF NOT EXISTS decision_rationale TEXT;

-- Chief loop notifications table (for notify-then-execute tier)
CREATE TABLE IF NOT EXISTS chief_loop_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES chief_loop_leases(id) ON DELETE SET NULL,
  decision_type TEXT NOT NULL,
  decision_summary TEXT NOT NULL,
  risk_score REAL NOT NULL,
  target_type TEXT,
  target_id TEXT,
  notification_channel TEXT NOT NULL DEFAULT 'slack'
    CHECK (notification_channel IN ('slack', 'in_app', 'email')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cln_org_status
  ON chief_loop_notifications(org_id, status)
  WHERE status = 'pending';

ALTER TABLE chief_loop_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY chief_loop_notifications_service
  ON chief_loop_notifications FOR ALL
  USING (true) WITH CHECK (true);
