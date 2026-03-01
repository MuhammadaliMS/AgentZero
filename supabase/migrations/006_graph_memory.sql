-- Migration 6: Graph Memory
-- Adds knowledge graph (entities + relationships), vector embeddings,
-- and temporal tracking for the Captain agent's memory system.

-- Enable pgvector for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- 1. entities — Nodes in the knowledge graph
-- ============================================================
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'person', 'project', 'control', 'decision', 'team',
    'tool', 'vendor', 'framework', 'document', 'process'
  )),
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,   -- lowercase, trimmed, for dedup
  description TEXT,
  attributes JSONB DEFAULT '{}',
  embedding vector(1536),         -- name+description embedding
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  mention_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(org_id, canonical_name, entity_type)
);

CREATE INDEX idx_entities_org ON entities(org_id);
CREATE INDEX idx_entities_type ON entities(org_id, entity_type);
CREATE INDEX idx_entities_canonical ON entities(org_id, canonical_name);
CREATE INDEX idx_entities_attributes ON entities USING GIN (attributes);
CREATE INDEX idx_entities_name_search ON entities USING GIN (
  to_tsvector('english', name || ' ' || COALESCE(description, ''))
);
CREATE INDEX idx_entities_embedding ON entities
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ============================================================
-- 2. entity_relationships — Edges in the knowledge graph
-- ============================================================
CREATE TABLE entity_relationships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  properties JSONB DEFAULT '{}',
  confidence FLOAT NOT NULL DEFAULT 1.0,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,            -- NULL = currently active
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (source_entity_id <> target_entity_id)
);

CREATE INDEX idx_relationships_org ON entity_relationships(org_id);
CREATE INDEX idx_relationships_source ON entity_relationships(source_entity_id);
CREATE INDEX idx_relationships_target ON entity_relationships(target_entity_id);
CREATE INDEX idx_relationships_type ON entity_relationships(org_id, relationship_type);
CREATE INDEX idx_relationships_temporal ON entity_relationships(valid_from, valid_to);
CREATE INDEX idx_relationships_active
  ON entity_relationships(org_id, source_entity_id, target_entity_id)
  WHERE valid_to IS NULL;

-- ============================================================
-- 3. memory_embeddings — Vector embeddings for memory rows
-- ============================================================
CREATE TABLE memory_embeddings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_id UUID NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(memory_id)
);

CREATE INDEX idx_memory_embeddings_memory ON memory_embeddings(memory_id);
CREATE INDEX idx_memory_embeddings_vector ON memory_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ============================================================
-- 4. memory_entity_links — Bridge: memory <-> entities
-- ============================================================
CREATE TABLE memory_entity_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_id UUID NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,

  UNIQUE(memory_id, entity_id)
);

CREATE INDEX idx_memory_entity_memory ON memory_entity_links(memory_id);
CREATE INDEX idx_memory_entity_entity ON memory_entity_links(entity_id);

-- ============================================================
-- 5. extraction_jobs — Track background extraction runs
-- ============================================================
CREATE TABLE extraction_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'completed', 'failed'
  )),
  entities_extracted INTEGER DEFAULT 0,
  relationships_extracted INTEGER DEFAULT 0,
  embeddings_generated INTEGER DEFAULT 0,
  error TEXT,
  model_used TEXT,
  tokens_used JSONB,
  cost_usd FLOAT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_extraction_jobs_org ON extraction_jobs(org_id);
CREATE INDEX idx_extraction_jobs_status ON extraction_jobs(status)
  WHERE status IN ('pending', 'processing');

-- ============================================================
-- 6. RLS Policies
-- ============================================================

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_entity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_jobs ENABLE ROW LEVEL SECURITY;

-- entities
CREATE POLICY "Org members can view their entities"
  ON entities FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Org members can create entities"
  ON entities FOR INSERT WITH CHECK (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Org members can update their entities"
  ON entities FOR UPDATE USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );

-- entity_relationships
CREATE POLICY "Org members can view their relationships"
  ON entity_relationships FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Org members can create relationships"
  ON entity_relationships FOR INSERT WITH CHECK (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Org members can update their relationships"
  ON entity_relationships FOR UPDATE USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );

-- memory_embeddings (inherits access through memory table FK)
CREATE POLICY "Org members can view memory embeddings"
  ON memory_embeddings FOR SELECT USING (
    memory_id IN (
      SELECT id FROM memory WHERE org_id IN (
        SELECT org_id FROM profiles WHERE id = auth.uid()
      )
    )
  );
CREATE POLICY "Org members can create memory embeddings"
  ON memory_embeddings FOR INSERT WITH CHECK (
    memory_id IN (
      SELECT id FROM memory WHERE org_id IN (
        SELECT org_id FROM profiles WHERE id = auth.uid()
      )
    )
  );

-- memory_entity_links
CREATE POLICY "Org members can view memory entity links"
  ON memory_entity_links FOR SELECT USING (
    memory_id IN (
      SELECT id FROM memory WHERE org_id IN (
        SELECT org_id FROM profiles WHERE id = auth.uid()
      )
    )
  );
CREATE POLICY "Org members can create memory entity links"
  ON memory_entity_links FOR INSERT WITH CHECK (
    memory_id IN (
      SELECT id FROM memory WHERE org_id IN (
        SELECT org_id FROM profiles WHERE id = auth.uid()
      )
    )
  );

-- extraction_jobs
CREATE POLICY "Org members can view extraction jobs"
  ON extraction_jobs FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Org members can create extraction jobs"
  ON extraction_jobs FOR INSERT WITH CHECK (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Org members can update extraction jobs"
  ON extraction_jobs FOR UPDATE USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );

-- ============================================================
-- 7. RPC Functions for graph traversal
-- ============================================================

-- Get entities connected within N hops
CREATE OR REPLACE FUNCTION get_entity_neighborhood(
  p_entity_id UUID,
  p_org_id UUID,
  p_max_hops INTEGER DEFAULT 2,
  p_active_only BOOLEAN DEFAULT true
)
RETURNS TABLE (
  entity_id UUID,
  entity_name TEXT,
  entity_type TEXT,
  entity_description TEXT,
  hop_distance INTEGER,
  relationship_type TEXT,
  relationship_direction TEXT,
  relationship_properties JSONB,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ
) AS $$
WITH RECURSIVE traversal AS (
  -- Base: starting entity at hop 0
  SELECT
    e.id AS entity_id,
    e.name AS entity_name,
    e.entity_type,
    e.description AS entity_description,
    0 AS hop_distance,
    NULL::TEXT AS relationship_type,
    NULL::TEXT AS relationship_direction,
    NULL::JSONB AS relationship_properties,
    NULL::TIMESTAMPTZ AS valid_from,
    NULL::TIMESTAMPTZ AS valid_to
  FROM entities e
  WHERE e.id = p_entity_id AND e.org_id = p_org_id

  UNION ALL

  -- Recursive: follow edges
  SELECT
    e.id,
    e.name,
    e.entity_type,
    e.description,
    t.hop_distance + 1,
    r.relationship_type,
    CASE WHEN r.source_entity_id = t.entity_id THEN 'outgoing' ELSE 'incoming' END,
    r.properties,
    r.valid_from,
    r.valid_to
  FROM traversal t
  JOIN entity_relationships r ON (
    r.source_entity_id = t.entity_id OR r.target_entity_id = t.entity_id
  )
  JOIN entities e ON (
    e.id = CASE
      WHEN r.source_entity_id = t.entity_id THEN r.target_entity_id
      ELSE r.source_entity_id
    END
  )
  WHERE t.hop_distance < p_max_hops
    AND r.org_id = p_org_id
    AND e.org_id = p_org_id
    AND (NOT p_active_only OR r.valid_to IS NULL)
)
SELECT DISTINCT ON (entity_id) * FROM traversal
ORDER BY entity_id, hop_distance;
$$ LANGUAGE sql STABLE;

-- Get entity timeline (chronological relationship changes)
CREATE OR REPLACE FUNCTION get_entity_timeline(
  p_entity_id UUID,
  p_org_id UUID,
  p_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  event_time TIMESTAMPTZ,
  event_type TEXT,
  relationship_type TEXT,
  related_entity_name TEXT,
  related_entity_type TEXT,
  properties JSONB,
  valid_to TIMESTAMPTZ
) AS $$
SELECT
  r.valid_from AS event_time,
  CASE
    WHEN r.source_entity_id = p_entity_id THEN 'outgoing'
    ELSE 'incoming'
  END AS event_type,
  r.relationship_type,
  e.name AS related_entity_name,
  e.entity_type AS related_entity_type,
  r.properties,
  r.valid_to
FROM entity_relationships r
JOIN entities e ON (
  e.id = CASE
    WHEN r.source_entity_id = p_entity_id THEN r.target_entity_id
    ELSE r.source_entity_id
  END
)
WHERE (r.source_entity_id = p_entity_id OR r.target_entity_id = p_entity_id)
  AND r.org_id = p_org_id
  AND (p_since IS NULL OR r.valid_from >= p_since)
ORDER BY r.valid_from DESC;
$$ LANGUAGE sql STABLE;

-- Semantic search on memories using vector similarity
CREATE OR REPLACE FUNCTION search_memories_by_embedding(
  p_org_id UUID,
  p_embedding vector(1536),
  p_limit INTEGER DEFAULT 10,
  p_category TEXT DEFAULT NULL
)
RETURNS TABLE (
  memory_id UUID,
  subject TEXT,
  content TEXT,
  category TEXT,
  confidence FLOAT,
  similarity FLOAT,
  related_entities TEXT[],
  created_at TIMESTAMPTZ
) AS $$
SELECT
  m.id AS memory_id,
  m.subject,
  m.content,
  m.category,
  m.confidence,
  1 - (me.embedding <=> p_embedding) AS similarity,
  m.related_entities,
  m.created_at
FROM memory m
JOIN memory_embeddings me ON me.memory_id = m.id
WHERE m.org_id = p_org_id
  AND (p_category IS NULL OR m.category = p_category)
ORDER BY me.embedding <=> p_embedding
LIMIT p_limit;
$$ LANGUAGE sql STABLE;
