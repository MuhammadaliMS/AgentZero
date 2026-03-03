-- 007_proactive_intelligence.sql
-- Proactive Intelligence Layer: patrol findings, feedback signals, user weights,
-- risk scoring on commitments, enriched nudges, brief metrics.

-- ─── New Tables ─────────────────────────────────────────────────────────

-- Patrol findings: results from background patrol scans (no LLM, pure DB)
CREATE TABLE patrol_findings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'deadline_approaching', 'deadline_overdue', 'stale_entity',
    'failing_control', 'unresolved_blocker', 'at_risk_commitment',
    'action_expiring'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  title TEXT NOT NULL,
  description TEXT,
  entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  commitment_id UUID REFERENCES commitments(id) ON DELETE SET NULL,
  action_id UUID REFERENCES actions(id) ON DELETE SET NULL,
  memory_id UUID REFERENCES memory(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'expired')),
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_patrol_findings_org ON patrol_findings(org_id);
CREATE INDEX idx_patrol_findings_open ON patrol_findings(org_id, status) WHERE status = 'open';
CREATE INDEX idx_patrol_findings_type ON patrol_findings(org_id, type);
CREATE INDEX idx_patrol_findings_commitment ON patrol_findings(commitment_id) WHERE commitment_id IS NOT NULL;

-- Feedback signals: tracks user interactions with briefs and nudges
CREATE TABLE feedback_signals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL CHECK (signal_type IN (
    'brief_read', 'nudge_acknowledged', 'nudge_dismissed',
    'commitment_acted_on', 'action_resolved_after_nudge'
  )),
  source_type TEXT NOT NULL CHECK (source_type IN ('brief', 'nudge', 'commitment', 'action')),
  source_id UUID NOT NULL,
  category TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feedback_signals_user ON feedback_signals(org_id, user_id);
CREATE INDEX idx_feedback_signals_source ON feedback_signals(source_type, source_id);
CREATE INDEX idx_feedback_signals_recent ON feedback_signals(user_id, created_at DESC);

-- User signal weights: per-user preference weights derived from feedback
CREATE TABLE user_signal_weights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  weight FLOAT NOT NULL DEFAULT 1.0,
  acted_count INTEGER NOT NULL DEFAULT 0,
  dismissed_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, category)
);

CREATE INDEX idx_user_signal_weights_user ON user_signal_weights(user_id);

-- ─── Column Additions ───────────────────────────────────────────────────

-- Risk scoring on commitments
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS risk_score INTEGER DEFAULT 0;
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS risk_computed_at TIMESTAMPTZ;

-- Enriched nudge tracking
ALTER TABLE nudges ADD COLUMN IF NOT EXISTS commitment_id UUID REFERENCES commitments(id) ON DELETE SET NULL;
ALTER TABLE nudges ADD COLUMN IF NOT EXISTS urgency_score INTEGER DEFAULT 0;
ALTER TABLE nudges ADD COLUMN IF NOT EXISTS source_finding_id UUID REFERENCES patrol_findings(id) ON DELETE SET NULL;
ALTER TABLE nudges ADD COLUMN IF NOT EXISTS batch_id TEXT;

-- Brief metrics for vs-yesterday comparison
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS metrics JSONB DEFAULT '{}';

-- ─── RLS Policies ───────────────────────────────────────────────────────

ALTER TABLE patrol_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_signal_weights ENABLE ROW LEVEL SECURITY;

-- patrol_findings: org members can read, service role can write
CREATE POLICY "Org members can view patrol findings"
  ON patrol_findings FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access patrol findings"
  ON patrol_findings FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- feedback_signals: users can see own, service role can write
CREATE POLICY "Users can view own feedback signals"
  ON feedback_signals FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Service role full access feedback signals"
  ON feedback_signals FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- user_signal_weights: users can see own, service role can manage
CREATE POLICY "Users can view own signal weights"
  ON user_signal_weights FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Service role full access signal weights"
  ON user_signal_weights FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );
