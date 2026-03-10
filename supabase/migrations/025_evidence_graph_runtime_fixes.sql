-- Migration 025: Evidence graph runtime fixes for live rollout
-- Fixes memory category support, vault link indexing, and canonical work/memory columns.

ALTER TABLE memory
  DROP CONSTRAINT IF EXISTS memory_category_check;

ALTER TABLE memory
  ADD CONSTRAINT memory_category_check CHECK (category IN (
    'decision', 'context', 'preference', 'relationship', 'fact',
    'task', 'meeting_outcome', 'project_status', 'blocker', 'deadline',
    'pattern', 'strategic_insight'
  ));

ALTER TABLE commitments
  ADD COLUMN IF NOT EXISTS owner_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS related_entity_ids UUID[] NOT NULL DEFAULT '{}';

ALTER TABLE memory
  ADD COLUMN IF NOT EXISTS source_artifact_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS primary_claim_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS citation_coverage REAL NOT NULL DEFAULT 0
    CHECK (citation_coverage BETWEEN 0 AND 1);

UPDATE commitments
SET owner_entity_id = NULLIF(metadata->>'owner_entity_id', '')::uuid
WHERE owner_entity_id IS NULL
  AND metadata ? 'owner_entity_id'
  AND (metadata->>'owner_entity_id') ~* '^[0-9a-f-]{36}$';

UPDATE commitments
SET related_entity_ids = COALESCE((
  SELECT array_remove(array_agg(
    CASE
      WHEN value ~* '^[0-9a-f-]{36}$' THEN value::uuid
      ELSE NULL
    END
  ), NULL)
  FROM jsonb_array_elements_text(COALESCE(metadata->'related_entity_ids', '[]'::jsonb)) AS value
), '{}'::uuid[])
WHERE related_entity_ids = '{}'
  AND metadata ? 'related_entity_ids';

UPDATE memory
SET source_artifact_ids = COALESCE((
  SELECT array_remove(array_agg(
    CASE
      WHEN value ~* '^[0-9a-f-]{36}$' THEN value::uuid
      ELSE NULL
    END
  ), NULL)
  FROM jsonb_array_elements_text(COALESCE(metadata->'source_artifact_ids', '[]'::jsonb)) AS value
), '{}'::uuid[])
WHERE source_artifact_ids = '{}'
  AND metadata ? 'source_artifact_ids';

UPDATE memory
SET primary_claim_ids = COALESCE((
  SELECT array_remove(array_agg(
    CASE
      WHEN value ~* '^[0-9a-f-]{36}$' THEN value::uuid
      ELSE NULL
    END
  ), NULL)
  FROM jsonb_array_elements_text(COALESCE(metadata->'primary_claim_ids', '[]'::jsonb)) AS value
), '{}'::uuid[])
WHERE primary_claim_ids = '{}'
  AND metadata ? 'primary_claim_ids';

UPDATE memory
SET citation_coverage = LEAST(GREATEST(COALESCE(NULLIF(metadata->>'citation_coverage', '')::real, citation_coverage), 0), 1)
WHERE metadata ? 'citation_coverage';

CREATE INDEX IF NOT EXISTS idx_vault_doc_links_doc
  ON vault_document_links (vault_document_id);

CREATE INDEX IF NOT EXISTS idx_commitments_related_entity_ids
  ON commitments USING GIN (related_entity_ids);

CREATE INDEX IF NOT EXISTS idx_commitments_owner_entity
  ON commitments (org_id, owner_entity_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_source_artifact_ids
  ON memory USING GIN (source_artifact_ids);

CREATE INDEX IF NOT EXISTS idx_memory_primary_claim_ids
  ON memory USING GIN (primary_claim_ids);
