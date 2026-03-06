-- ============================================================================
-- Migration 016: Carry-Forward Context for Chief Loop
-- ============================================================================
-- Adds a carry_forward TEXT column to chief_loop_leases so each completed run
-- can leave a template-based summary for the next run. No LLM cost — pure string.

ALTER TABLE chief_loop_leases
  ADD COLUMN IF NOT EXISTS carry_forward TEXT;

-- Update release_chief_lease RPC to accept carry_forward parameter
CREATE OR REPLACE FUNCTION release_chief_lease(
  p_lease_id UUID,
  p_status TEXT DEFAULT 'completed',
  p_result_summary TEXT DEFAULT NULL,
  p_signals_ingested INT DEFAULT 0,
  p_outcomes_created INT DEFAULT 0,
  p_steps_executed INT DEFAULT 0,
  p_cost_usd REAL DEFAULT 0,
  p_carry_forward TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE chief_loop_leases
    SET status = p_status,
        completed_at = now(),
        result_summary = p_result_summary,
        signals_ingested = p_signals_ingested,
        outcomes_created = p_outcomes_created,
        steps_executed = p_steps_executed,
        cost_usd = p_cost_usd,
        carry_forward = p_carry_forward
    WHERE id = p_lease_id
      AND status = 'running';
END $$;
