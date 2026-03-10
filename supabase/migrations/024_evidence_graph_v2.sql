-- Migration 024: Agentic Evidence Graph + Generated Vault
-- Canonical truth becomes source_artifacts -> evidence_items -> claims,
-- with commitments / decision threads / vault docs projected from that state.

CREATE TABLE IF NOT EXISTS source_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('meeting', 'slack', 'email', 'chat')),
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  raw_ref TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, channel, external_id)
);

CREATE INDEX IF NOT EXISTS idx_source_artifacts_org_channel
  ON source_artifacts (org_id, channel, started_at DESC);

CREATE TABLE IF NOT EXISTS evidence_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL REFERENCES source_artifacts(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL,
  author_name TEXT,
  author_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  happened_at TIMESTAMPTZ,
  text TEXT NOT NULL,
  source_anchor TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (artifact_id, sequence_no),
  UNIQUE (artifact_id, source_anchor)
);

CREATE INDEX IF NOT EXISTS idx_evidence_items_artifact
  ON evidence_items (artifact_id, sequence_no);

CREATE INDEX IF NOT EXISTS idx_evidence_items_org_happened
  ON evidence_items (org_id, happened_at DESC);

CREATE INDEX IF NOT EXISTS idx_evidence_items_embedding
  ON evidence_items USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  artifact_id UUID REFERENCES source_artifacts(id) ON DELETE SET NULL,
  claim_key TEXT NOT NULL,
  claim_kind TEXT NOT NULL CHECK (claim_kind IN ('relationship', 'decision', 'commitment', 'status', 'fact')),
  subject_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  object_value TEXT,
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  evidence_status TEXT NOT NULL DEFAULT 'supported' CHECK (evidence_status IN ('supported', 'context_only', 'manual')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'disputed', 'retracted')),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, claim_key)
);

CREATE INDEX IF NOT EXISTS idx_claims_org_subject
  ON claims (org_id, subject_entity_id, valid_from DESC);

CREATE INDEX IF NOT EXISTS idx_claims_org_artifact
  ON claims (org_id, artifact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claims_active
  ON claims (org_id, status, valid_from DESC)
  WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS claim_evidence_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  evidence_item_id UUID NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN ('support', 'context', 'contradiction')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (claim_id, evidence_item_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim
  ON claim_evidence_links (claim_id);

CREATE INDEX IF NOT EXISTS idx_claim_evidence_item
  ON claim_evidence_links (evidence_item_id);

CREATE TABLE IF NOT EXISTS decision_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  canonical_title TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'superseded', 'cancelled')),
  current_claim_id UUID REFERENCES claims(id) ON DELETE SET NULL,
  first_artifact_id UUID REFERENCES source_artifacts(id) ON DELETE SET NULL,
  last_artifact_id UUID REFERENCES source_artifacts(id) ON DELETE SET NULL,
  related_entity_ids UUID[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_decision_threads_org_status
  ON decision_threads (org_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_threads_entities
  ON decision_threads USING GIN (related_entity_ids);

ALTER TABLE commitments
  ADD COLUMN IF NOT EXISTS source_claim_id UUID REFERENCES claims(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS latest_evidence_item_id UUID REFERENCES evidence_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decision_thread_id UUID REFERENCES decision_threads(id) ON DELETE SET NULL;

ALTER TABLE commitments
  ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

ALTER TABLE memory
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE strategic_narratives
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE meeting_action_items
  ADD COLUMN IF NOT EXISTS owner_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commitment_id UUID REFERENCES commitments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_artifact_id UUID REFERENCES source_artifacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence_item_id UUID REFERENCES evidence_items(id) ON DELETE SET NULL;

ALTER TABLE meeting_decisions
  ADD COLUMN IF NOT EXISTS decided_by_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decision_thread_id UUID REFERENCES decision_threads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_artifact_id UUID REFERENCES source_artifacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence_item_id UUID REFERENCES evidence_items(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS vault_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'source_artifact', 'entity', 'commitment', 'decision_thread', 'timeline', 'narrative'
  )),
  content_markdown TEXT NOT NULL DEFAULT '',
  frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_mode TEXT NOT NULL DEFAULT 'generated' CHECK (source_mode IN ('generated', 'manual', 'hybrid')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, path)
);

CREATE INDEX IF NOT EXISTS idx_vault_documents_org_type
  ON vault_documents (org_id, document_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS vault_document_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vault_document_id UUID NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
  link_kind TEXT NOT NULL CHECK (link_kind IN ('entity', 'claim', 'commitment', 'narrative', 'evidence_item', 'artifact', 'decision_thread')),
  target_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (vault_document_id, link_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_vault_document_links_target
  ON vault_document_links (org_id, link_kind, target_id);

ALTER TABLE source_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_evidence_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_document_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view source artifacts"
  ON source_artifacts FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access source artifacts"
  ON source_artifacts FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Org members can view evidence items"
  ON evidence_items FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access evidence items"
  ON evidence_items FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Org members can view claims"
  ON claims FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access claims"
  ON claims FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Org members can view claim evidence links"
  ON claim_evidence_links FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access claim evidence links"
  ON claim_evidence_links FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Org members can view decision threads"
  ON decision_threads FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access decision threads"
  ON decision_threads FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Org members can view vault documents"
  ON vault_documents FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access vault documents"
  ON vault_documents FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Org members can view vault document links"
  ON vault_document_links FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access vault document links"
  ON vault_document_links FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
