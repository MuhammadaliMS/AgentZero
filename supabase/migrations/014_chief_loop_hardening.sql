-- ============================================================================
-- Migration 014: Chief Loop Hardening — Atomic lease + budget query indexes
-- ============================================================================
-- Addresses audit findings:
--   P0: Race condition in lease acquisition
--   P1: Missing composite index for budget enforcement queries

-- ─── Unique partial index: prevent concurrent running leases per org ─────
-- This is the safety net. Even if the RPC function has a bug, Postgres will
-- refuse to let two 'running' leases exist for the same org.

CREATE UNIQUE INDEX IF NOT EXISTS idx_cll_one_active_per_org
  ON chief_loop_leases(org_id)
  WHERE status = 'running';

-- ─── Atomic lease acquisition RPC ────────────────────────────────────────
-- Replaces the SELECT-then-INSERT pattern in TypeScript with a single
-- atomic SQL function. PgBouncer-safe (runs in one statement/transaction).

CREATE OR REPLACE FUNCTION try_acquire_chief_lease(
  p_org_id UUID,
  p_ttl_minutes INT DEFAULT 55
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  _now TIMESTAMPTZ := now();
  _lease_id UUID;
BEGIN
  -- 1. Expire stale running leases for this org
  UPDATE chief_loop_leases
    SET status = 'failed',
        completed_at = _now,
        error = 'expired_by_new_acquisition'
    WHERE org_id = p_org_id
      AND status = 'running'
      AND expires_at <= _now;

  -- 2. Try to insert a new running lease.
  --    The unique partial index (idx_cll_one_active_per_org) prevents
  --    two concurrent 'running' leases for the same org.
  INSERT INTO chief_loop_leases (org_id, status, acquired_at, expires_at)
    VALUES (p_org_id, 'running', _now, _now + make_interval(mins => p_ttl_minutes))
    RETURNING id INTO _lease_id;

  RETURN _lease_id;

EXCEPTION
  WHEN unique_violation THEN
    -- Another lease is already running for this org — skip
    RETURN NULL;
END $$;

-- ─── Release lease RPC ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION release_chief_lease(
  p_lease_id UUID,
  p_status TEXT DEFAULT 'completed',
  p_result_summary TEXT DEFAULT NULL,
  p_signals_ingested INT DEFAULT 0,
  p_outcomes_created INT DEFAULT 0,
  p_steps_executed INT DEFAULT 0,
  p_cost_usd REAL DEFAULT 0
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE chief_loop_leases
    SET status = p_status,
        completed_at = now(),
        result_summary = p_result_summary,
        signals_ingested = p_signals_ingested,
        outcomes_created = p_outcomes_created,
        steps_executed = p_steps_executed,
        cost_usd = p_cost_usd
    WHERE id = p_lease_id
      AND status = 'running';
END $$;

-- ─── Budget enforcement indexes ──────────────────────────────────────────
-- Phase E queries outcome_steps by org + status + updated_at for budget checks.

CREATE INDEX IF NOT EXISTS idx_outcome_steps_org_status
  ON outcome_steps(org_id, status)
  WHERE status IN ('completed', 'failed');

-- Lease status check for the 'expired' cleanup
ALTER TABLE chief_loop_leases
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;
