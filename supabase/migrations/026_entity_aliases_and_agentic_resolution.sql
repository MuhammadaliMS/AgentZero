-- Migration 026: Entity aliases + agentic identity resolution support

CREATE TABLE IF NOT EXISTS entity_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  alias_kind TEXT NOT NULL DEFAULT 'observed' CHECK (alias_kind IN ('canonical', 'observed', 'llm_inferred', 'merged')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  source TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, entity_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_org_lookup
  ON entity_aliases (org_id, entity_type, normalized_alias);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity
  ON entity_aliases (entity_id);

ALTER TABLE entity_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view entity aliases"
  ON entity_aliases FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "Service role full access entity aliases"
  ON entity_aliases FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

INSERT INTO entity_aliases (
  org_id,
  entity_id,
  entity_type,
  alias,
  normalized_alias,
  alias_kind,
  confidence,
  source,
  metadata
)
SELECT
  e.org_id,
  e.id,
  e.entity_type,
  e.name,
  e.canonical_name,
  'canonical',
  1.0,
  'migration_backfill',
  '{}'::jsonb
FROM entities e
ON CONFLICT (org_id, entity_id, normalized_alias) DO NOTHING;
