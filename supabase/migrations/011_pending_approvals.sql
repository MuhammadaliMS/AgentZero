-- ─── Migration 011: Pending Approvals + Foundation Fixes ─────────────────────
-- Phase 0 of Chief-of-Staff High-Agency Agent.
--
-- NOTE: pending_approvals CREATE TABLE was moved into migration 010 (before
-- outcome_steps) to fix FK ordering. This migration is now idempotent —
-- IF NOT EXISTS ensures no-op if table already exists from 010.
-- The FK fixup block is also idempotent.
--
-- 0a. Create pending_approvals table (no-op if already exists from 010)
-- 0c. Fix outcome_steps FK to pending_approvals (no-op if already exists)

-- ─── 0a. pending_approvals table ──────────────────────────────────────────────

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
-- NOTE: If a previous run of this migration created the wide-open policy,
-- drop it to lock the table down properly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pending_approvals' AND policyname = 'service_role_all_pending_approvals'
  ) THEN
    DROP POLICY "service_role_all_pending_approvals" ON pending_approvals;
  END IF;
END $$;

-- ─── 0c. Fix outcome_steps FK to pending_approvals ────────────────────────────
-- Migration 010 line 149 references pending_approvals(approval_id) but the
-- table didn't exist. Re-add the FK if it failed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'outcome_steps_approval_id_fkey'
      AND table_name = 'outcome_steps'
  ) THEN
    ALTER TABLE outcome_steps
      ADD CONSTRAINT outcome_steps_approval_id_fkey
      FOREIGN KEY (approval_id) REFERENCES pending_approvals(approval_id)
      ON DELETE SET NULL;
  END IF;
END $$;
