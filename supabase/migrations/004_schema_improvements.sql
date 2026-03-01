-- Migration 4: Schema Improvements
-- Addresses gaps identified by cross-referencing actual backend code.

-- ============================================================
-- 1. messages: add parts column for agentic UI persistence
--    The agentic chat renders messages as MessagePart[] arrays.
--    Without this column, parts are lost on page reload.
-- ============================================================
ALTER TABLE messages ADD COLUMN parts JSONB;

-- ============================================================
-- 2. conversations: add pinned flag, archived_at, and CHECK constraint
-- ============================================================
ALTER TABLE conversations ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('active', 'archived', 'deleted'));

-- ============================================================
-- 3. profiles: add slack_user_id and avatar_url
--    slack_user_id eliminates an expensive email-based lookup in
--    the Slack events route. avatar_url is standard for chat UIs.
-- ============================================================
ALTER TABLE profiles ADD COLUMN slack_user_id TEXT;
ALTER TABLE profiles ADD COLUMN avatar_url TEXT;
CREATE UNIQUE INDEX idx_profiles_slack_user_id
  ON profiles(slack_user_id)
  WHERE slack_user_id IS NOT NULL;

-- ============================================================
-- 4. organization_integrations: queryable token expiry, disconnected_at,
--    and a CHECK constraint on health_status
-- ============================================================
ALTER TABLE organization_integrations ADD COLUMN token_expires_at TIMESTAMPTZ;
ALTER TABLE organization_integrations ADD COLUMN disconnected_at TIMESTAMPTZ;
ALTER TABLE organization_integrations
  ADD CONSTRAINT org_integrations_health_check
  CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'error'));

-- Index for proactive token refresh job: find tokens expiring soon
CREATE INDEX idx_org_integrations_token_expiry
  ON organization_integrations(token_expires_at)
  WHERE is_active = true AND token_expires_at IS NOT NULL;

-- Index for Slack event routing via workspace_id (JSONB functional index)
-- Used in: WHERE (user_metadata->>'workspace_id') = $1
CREATE INDEX idx_org_integrations_slack_workspace
  ON organization_integrations((user_metadata->>'workspace_id'))
  WHERE is_active = true;

-- ============================================================
-- 5. worker_executions: add conversation_id for observability tracing
-- ============================================================
ALTER TABLE worker_executions
  ADD COLUMN conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL;

CREATE INDEX idx_worker_executions_conversation
  ON worker_executions(conversation_id)
  WHERE conversation_id IS NOT NULL;

-- ============================================================
-- 6. actions: add conversation_id to trace action origin
-- ============================================================
ALTER TABLE actions
  ADD COLUMN conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL;

CREATE INDEX idx_actions_conversation
  ON actions(conversation_id)
  WHERE conversation_id IS NOT NULL;

-- ============================================================
-- 7. commitments: add conversation_id to trace commitment origin
-- ============================================================
ALTER TABLE commitments
  ADD COLUMN conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL;

CREATE INDEX idx_commitments_conversation
  ON commitments(conversation_id)
  WHERE conversation_id IS NOT NULL;

-- ============================================================
-- 8. onboarding_state: add completed_at timestamp
-- ============================================================
ALTER TABLE onboarding_state ADD COLUMN completed_at TIMESTAMPTZ;

-- ============================================================
-- 9. Fix GIN index on memory for full-text search
--    Old index: to_tsvector('english', subject || ' ' || content)
--    recall_memory calls textSearch('subject', ...) — column-only.
--    We keep the combined index for future use but add a dedicated
--    tsvector column that the client can use for combined search.
--    For now, add an expression index that matches the query exactly.
-- ============================================================

-- Combined search index (subject + content), used by future semantic search
-- The existing index from migration 001 already covers this expression.
-- Add a separate index for subject-only textSearch queries:
CREATE INDEX idx_memory_subject_search
  ON memory USING GIN (to_tsvector('english', subject));

-- ============================================================
-- 10. Additional performance indexes missing from initial schema
-- ============================================================

-- actions: fetch pending actions sorted by priority quickly
CREATE INDEX idx_actions_org_user_pending
  ON actions(org_id, user_id, priority)
  WHERE status = 'pending';

-- actions: fetch by due date for expiry jobs
CREATE INDEX idx_actions_due_at
  ON actions(due_at)
  WHERE status = 'pending' AND due_at IS NOT NULL;

-- commitments: fetch by owner and status
CREATE INDEX idx_commitments_owner_status
  ON commitments(owner_id, status)
  WHERE owner_id IS NOT NULL;

-- briefs: fetch pending/unsent briefs
CREATE INDEX idx_briefs_status
  ON briefs(org_id, status, created_at DESC)
  WHERE status IN ('draft', 'sent');

-- worker_executions: fetch recent running executions for health checks
CREATE INDEX idx_worker_executions_running
  ON worker_executions(org_id, created_at DESC)
  WHERE status = 'running';

-- nudges: fetch pending nudges sorted by priority
CREATE INDEX idx_nudges_pending_priority
  ON nudges(org_id, user_id, priority)
  WHERE status = 'pending';

-- memory: fetch memories that expire soon for cleanup jobs
CREATE INDEX idx_memory_expires_at
  ON memory(expires_at)
  WHERE expires_at IS NOT NULL;

-- messages: get latest message in a conversation quickly
CREATE INDEX idx_messages_conversation_latest
  ON messages(conversation_id, created_at DESC);

-- conversations: fetch pinned conversations
CREATE INDEX idx_conversations_pinned
  ON conversations(org_id, user_id, created_at DESC)
  WHERE pinned = true;

-- conversations: fetch archived conversations
CREATE INDEX idx_conversations_archived
  ON conversations(org_id, user_id, archived_at DESC)
  WHERE archived_at IS NOT NULL;
