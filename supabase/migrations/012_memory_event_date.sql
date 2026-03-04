-- Migration 012: Add event_date to memory table for timeline association
-- Allows memories to be associated with a real-world date (e.g., meeting date,
-- decision date) rather than just the created_at timestamp.

ALTER TABLE memory ADD COLUMN IF NOT EXISTS event_date TIMESTAMPTZ;

-- Index for timeline queries: "what happened on/around this date?"
CREATE INDEX IF NOT EXISTS idx_memory_event_date
  ON memory (org_id, event_date)
  WHERE event_date IS NOT NULL;

COMMENT ON COLUMN memory.event_date IS 'Real-world date this memory relates to (e.g., meeting date, decision date). Distinct from created_at which tracks when the memory was stored.';
