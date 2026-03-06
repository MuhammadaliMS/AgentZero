-- ============================================================================
-- Migration 017: Procedural Memory
-- ============================================================================
-- Stores proven approach patterns ("what works") learned from past chief loop
-- runs. Agents query this to apply successful strategies to similar situations.
-- Distinct from episodic memory (what happened) — this is prescriptive knowledge.

CREATE TABLE IF NOT EXISTS procedural_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  trigger_pattern TEXT NOT NULL,            -- "When email from VP mentions deadline"
  successful_approach TEXT NOT NULL,        -- "Create high-priority outcome with 2-step plan"
  context_tags TEXT[] DEFAULT '{}',         -- ["email", "deadline", "executive"]
  success_count INT DEFAULT 1,
  failure_count INT DEFAULT 0,
  last_applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  embedding VECTOR(1536)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_procedural_memory_org
  ON procedural_memory(org_id);

CREATE INDEX IF NOT EXISTS idx_procedural_memory_tags
  ON procedural_memory USING GIN(context_tags);

-- Note: Embedding similarity index (ivfflat) requires existing rows to build.
-- Add later once data accumulates:
-- CREATE INDEX idx_procedural_memory_embedding
--   ON procedural_memory USING ivfflat(embedding vector_cosine_ops) WITH (lists = 10);

-- RLS: service-role only (chief loop runs as admin)
ALTER TABLE procedural_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY procedural_memory_service
  ON procedural_memory FOR ALL
  USING (true) WITH CHECK (true);

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_procedural_memory_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_procedural_memory_updated_at
  BEFORE UPDATE ON procedural_memory
  FOR EACH ROW
  EXECUTE FUNCTION update_procedural_memory_updated_at();
