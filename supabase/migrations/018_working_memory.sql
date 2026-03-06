-- ============================================================================
-- Migration 018: Working Memory
-- ============================================================================
-- Structured JSON working memory per org, replacing the TEXT carry_forward
-- field for richer inter-run state persistence. One row per org, upserted
-- at the end of each chief loop run.

CREATE TABLE IF NOT EXISTS working_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Free-form synthesis (replaces carry_forward TEXT on leases)
  running_summary TEXT NOT NULL DEFAULT '',

  -- Structured state fields
  attention_items JSONB NOT NULL DEFAULT '[]',   -- Items requiring ongoing attention
  predictions JSONB NOT NULL DEFAULT '[]',       -- Testable predictions from decisions
  deferred_items JSONB NOT NULL DEFAULT '[]',    -- Items deferred for future cycles
  decision_log JSONB NOT NULL DEFAULT '[]',      -- Recent decision trail (last ~20)
  accuracy_stats JSONB NOT NULL DEFAULT '{}',    -- Per-type accuracy aggregates

  -- Optimistic concurrency
  version INTEGER NOT NULL DEFAULT 1,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(org_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_working_memory_org
  ON working_memory(org_id);

-- RLS: service-role only (chief loop runs as admin)
ALTER TABLE working_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY working_memory_service
  ON working_memory FOR ALL
  USING (true) WITH CHECK (true);

-- Auto-update updated_at and version
CREATE OR REPLACE FUNCTION update_working_memory_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  NEW.version = OLD.version + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_working_memory_updated_at
  BEFORE UPDATE ON working_memory
  FOR EACH ROW
  EXECUTE FUNCTION update_working_memory_updated_at();
