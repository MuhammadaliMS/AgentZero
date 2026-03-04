-- 008_high_agency_memory.sql
-- High-Agency Memory System v3: graph insights, contradiction detection,
-- utility tracking, entity lifecycle (decay/dormancy/archival/pinning),
-- compression support, and 8 RPC functions.
--
-- New tables: graph_insights, insight_actions, contradiction_resolutions,
--             memory_utility_events
-- Extended:   entities (7 new columns + trigger + indexes)
-- RPCs:       8 functions for decay, access, search, co-occurrence,
--             velocity, repetition, lifecycle, and insight upsert

-- ============================================================
-- 1. graph_insights — Patterns, contradictions, anomalies, etc.
-- ============================================================

CREATE TABLE graph_insights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  insight_type TEXT NOT NULL CHECK (insight_type IN (
    'pattern', 'contradiction', 'anomaly', 'stale', 'correlation',
    'compression', 'risk', 'opportunity'
  )),
  category TEXT,
  summary TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  utility_score REAL NOT NULL DEFAULT 0,
  related_entity_ids UUID[] NOT NULL DEFAULT '{}',
  evidence JSONB NOT NULL DEFAULT '{}',
  action_template JSONB,
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'confirmed', 'dismissed', 'expired', 'routed', 'superseded'
  )),
  routed_finding_id UUID REFERENCES patrol_findings(id) ON DELETE SET NULL,
  superseded_by UUID REFERENCES graph_insights(id) ON DELETE SET NULL,
  times_triggered INTEGER NOT NULL DEFAULT 1,
  last_triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE graph_insights
  ADD CONSTRAINT uq_gi_idemp UNIQUE (org_id, idempotency_key);

CREATE INDEX idx_gi_org_active
  ON graph_insights(org_id) WHERE status = 'active';
CREATE INDEX idx_gi_type
  ON graph_insights(org_id, insight_type);
CREATE INDEX idx_gi_expiry
  ON graph_insights(expires_at) WHERE status = 'active';
CREATE INDEX idx_gi_entities
  ON graph_insights USING GIN (related_entity_ids);
CREATE INDEX idx_gi_routed
  ON graph_insights(org_id) WHERE status = 'active' AND routed_finding_id IS NULL;

-- ============================================================
-- 2. insight_actions — Closed-loop: insight → finding → outcome
-- ============================================================

CREATE TABLE insight_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  insight_id UUID NOT NULL REFERENCES graph_insights(id) ON DELETE CASCADE,
  finding_id UUID REFERENCES patrol_findings(id) ON DELETE SET NULL,
  action_id UUID REFERENCES actions(id) ON DELETE SET NULL,
  decision_mode TEXT NOT NULL CHECK (decision_mode IN ('auto', 'recommended', 'clarify')),
  policy_path TEXT,
  execution_result TEXT NOT NULL DEFAULT 'pending' CHECK (execution_result IN (
    'pending', 'executed', 'approved', 'rejected', 'expired'
  )),
  outcome_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_ia_insight ON insight_actions(insight_id);
CREATE INDEX idx_ia_org ON insight_actions(org_id);
CREATE INDEX idx_ia_finding ON insight_actions(finding_id) WHERE finding_id IS NOT NULL;

-- ============================================================
-- 3. contradiction_resolutions — How contradictions were resolved
-- ============================================================

CREATE TABLE contradiction_resolutions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contradiction_id UUID NOT NULL REFERENCES graph_insights(id) ON DELETE CASCADE,
  chosen_truth JSONB NOT NULL,
  resolver_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  resolution_source TEXT NOT NULL CHECK (resolution_source IN (
    'chat', 'slack', 'brief', 'auto'
  )),
  rationale TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cr_contradiction ON contradiction_resolutions(contradiction_id);
CREATE INDEX idx_cr_org ON contradiction_resolutions(org_id);

-- ============================================================
-- 4. memory_utility_events — Track entity/memory utility funnel
-- ============================================================

CREATE TABLE memory_utility_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  memory_id UUID REFERENCES memory(id) ON DELETE SET NULL,
  insight_id UUID REFERENCES graph_insights(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'retrieved', 'injected', 'cited', 'accepted', 'acted'
  )),
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  source_channel TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mue_entity ON memory_utility_events(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX idx_mue_org ON memory_utility_events(org_id, created_at);
CREATE INDEX idx_mue_insight ON memory_utility_events(insight_id) WHERE insight_id IS NOT NULL;

-- ============================================================
-- 5. Entity columns — Lifecycle, utility, decay, pinning
-- ============================================================

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS utility_score REAL NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'dormant', 'archived', 'pinned', 'conflicted')),
  ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS memory_class TEXT NOT NULL DEFAULT 'default'
    CHECK (memory_class IN (
      'person', 'project', 'decision', 'control', 'team',
      'tool', 'vendor', 'framework', 'document', 'process', 'default'
    )),
  ADD COLUMN IF NOT EXISTS last_decay_at TIMESTAMPTZ DEFAULT now();

-- Backfill memory_class from entity_type for existing rows
UPDATE entities SET memory_class = entity_type
WHERE entity_type IN (
  'person', 'project', 'decision', 'control', 'team',
  'tool', 'vendor', 'framework', 'document', 'process'
);

-- Auto-pin audit-critical entity types
UPDATE entities SET is_pinned = true, state = 'pinned'
WHERE entity_type IN ('control', 'decision') AND is_pinned = false;

-- Trigger: keep memory_class in sync with entity_type
CREATE OR REPLACE FUNCTION sync_memory_class()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.entity_type IN (
    'person', 'project', 'decision', 'control', 'team',
    'tool', 'vendor', 'framework', 'document', 'process'
  ) THEN
    NEW.memory_class := NEW.entity_type;
  ELSE
    NEW.memory_class := 'default';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_memory_class
  BEFORE INSERT OR UPDATE OF entity_type ON entities
  FOR EACH ROW EXECUTE FUNCTION sync_memory_class();

CREATE INDEX idx_entities_state ON entities(org_id, state);
CREATE INDEX idx_entities_decay ON entities(org_id, last_decay_at)
  WHERE state = 'active';
CREATE INDEX idx_entities_utility ON entities(org_id, utility_score DESC)
  WHERE state IN ('active', 'pinned');

-- ============================================================
-- 6. RLS Policies
-- ============================================================

ALTER TABLE graph_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contradiction_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_utility_events ENABLE ROW LEVEL SECURITY;

-- graph_insights: org members SELECT + UPDATE (confirm/dismiss), service_role ALL
CREATE POLICY "Org members can view graph insights"
  ON graph_insights FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
-- Org members can only confirm or dismiss insights (restrict status transitions)
CREATE POLICY "Org members can update graph insights"
  ON graph_insights FOR UPDATE USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  ) WITH CHECK (
    -- Only allow setting status to confirm/dismiss values
    status IN ('confirmed', 'dismissed')
  );
CREATE POLICY "Service role full access graph insights"
  ON graph_insights FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- insight_actions: org members SELECT, service_role ALL
CREATE POLICY "Org members can view insight actions"
  ON insight_actions FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access insight actions"
  ON insight_actions FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- contradiction_resolutions: org members SELECT + INSERT (resolve), service_role ALL
CREATE POLICY "Org members can view contradiction resolutions"
  ON contradiction_resolutions FOR SELECT USING (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Org members can create contradiction resolutions"
  ON contradiction_resolutions FOR INSERT WITH CHECK (
    org_id IN (SELECT org_id FROM profiles WHERE id = auth.uid())
  );
CREATE POLICY "Service role full access contradiction resolutions"
  ON contradiction_resolutions FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- memory_utility_events: service_role only (internal tracking)
CREATE POLICY "Service role full access memory utility events"
  ON memory_utility_events FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- ============================================================
-- 7. RPC Functions (8 total)
-- ============================================================

-- ─── 7a. get_relevant_entities ─────────────────────────────
-- Per-class exponential decay with ln() dampening + utility boost.
-- Returns entities ranked by relevance, only active/pinned states.
--
-- Decay constants per memory_class (λ = ln(2)/half_life_days):
--   person: 60d → 0.0116    project: 30d → 0.0231
--   decision: 90d → 0.0077  control: 45d → 0.0154
--   team: 60d → 0.0116      tool: 120d → 0.0058
--   vendor: 120d → 0.0058   framework: 120d → 0.0058
--   document: 30d → 0.0231  process: 45d → 0.0154
--   default: 30d → 0.0231

CREATE OR REPLACE FUNCTION get_relevant_entities(
  p_org_id UUID,
  p_limit INTEGER DEFAULT 20,
  p_min_relevance REAL DEFAULT 0.1
)
RETURNS TABLE (
  entity_id UUID,
  entity_name TEXT,
  entity_type TEXT,
  entity_description TEXT,
  mention_count INTEGER,
  relevance_score REAL,
  entity_state TEXT,
  is_entity_pinned BOOLEAN,
  utility REAL,
  memory_cls TEXT
) AS $$
WITH scored AS (
  SELECT
    e.id AS entity_id,
    e.name AS entity_name,
    e.entity_type,
    e.description AS entity_description,
    e.mention_count,
    (
      -- ln(mention_count + 1) dampens high-mention entities
      ln(e.mention_count + 1) *
      -- Exponential decay based on memory class half-life
      exp(
        -1.0 * (
          CASE e.memory_class
            WHEN 'person'    THEN 0.0116
            WHEN 'project'   THEN 0.0231
            WHEN 'decision'  THEN 0.0077
            WHEN 'control'   THEN 0.0154
            WHEN 'team'      THEN 0.0116
            WHEN 'tool'      THEN 0.0058
            WHEN 'vendor'    THEN 0.0058
            WHEN 'framework' THEN 0.0058
            WHEN 'document'  THEN 0.0231
            WHEN 'process'   THEN 0.0154
            ELSE 0.0231  -- default
          END
        ) * EXTRACT(EPOCH FROM (now() - e.last_seen_at)) / 86400.0
      )
      -- Utility boost (capped at contribution of 0.6)
      + LEAST(e.utility_score, 2.0) * 0.3
    )::REAL AS relevance_score,
    e.state AS entity_state,
    e.is_pinned AS is_entity_pinned,
    e.utility_score AS utility,
    e.memory_class AS memory_cls
  FROM entities e
  WHERE e.org_id = p_org_id
    AND e.state IN ('active', 'pinned')
)
SELECT * FROM scored
WHERE relevance_score >= p_min_relevance
ORDER BY relevance_score DESC
LIMIT p_limit;
$$ LANGUAGE sql STABLE;


-- ─── 7b. bump_entity_access ───────────────────────────────
-- Increment access_count and set last_accessed_at for a batch of entities.

CREATE OR REPLACE FUNCTION bump_entity_access(
  p_org_id UUID,
  p_entity_ids UUID[]
)
RETURNS void AS $$
UPDATE entities
SET
  access_count = access_count + 1,
  last_accessed_at = now()
WHERE id = ANY(p_entity_ids)
  AND org_id = p_org_id;
$$ LANGUAGE sql VOLATILE;


-- ─── 7c. search_entities_by_embedding ─────────────────────
-- Vector similarity search on entity embeddings. No result cap.

CREATE OR REPLACE FUNCTION search_entities_by_embedding(
  p_org_id UUID,
  p_embedding vector(1536),
  p_limit INTEGER DEFAULT 8,
  p_min_similarity REAL DEFAULT 0.65
)
RETURNS TABLE (
  entity_id UUID,
  entity_name TEXT,
  entity_type TEXT,
  entity_description TEXT,
  canonical_name TEXT,
  similarity REAL,
  mention_count INTEGER,
  entity_state TEXT,
  utility REAL
) AS $$
SELECT
  e.id AS entity_id,
  e.name AS entity_name,
  e.entity_type,
  e.description AS entity_description,
  e.canonical_name,
  (1 - (e.embedding <=> p_embedding))::REAL AS similarity,
  e.mention_count,
  e.state AS entity_state,
  e.utility_score AS utility
FROM entities e
WHERE e.org_id = p_org_id
  AND e.embedding IS NOT NULL
  AND e.state != 'archived'  -- Don't return archived entities in search results
  AND (1 - (e.embedding <=> p_embedding))::REAL >= p_min_similarity
ORDER BY e.embedding <=> p_embedding
LIMIT p_limit;
$$ LANGUAGE sql STABLE;


-- ─── 7d. find_co_occurring_entities ───────────────────────
-- Entity pairs that share relationships (for pattern detection).

CREATE OR REPLACE FUNCTION find_co_occurring_entities(
  p_org_id UUID,
  p_min_co_occurrences INTEGER DEFAULT 3,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  entity_a_id UUID,
  entity_a_name TEXT,
  entity_b_id UUID,
  entity_b_name TEXT,
  co_occurrence_count BIGINT,
  relationship_types TEXT[]
) AS $$
SELECT
  r.source_entity_id AS entity_a_id,
  ea.name AS entity_a_name,
  r.target_entity_id AS entity_b_id,
  eb.name AS entity_b_name,
  COUNT(*) AS co_occurrence_count,
  ARRAY_AGG(DISTINCT r.relationship_type) AS relationship_types
FROM entity_relationships r
JOIN entities ea ON ea.id = r.source_entity_id
JOIN entities eb ON eb.id = r.target_entity_id
WHERE r.org_id = p_org_id
GROUP BY r.source_entity_id, ea.name, r.target_entity_id, eb.name
HAVING COUNT(*) >= p_min_co_occurrences
ORDER BY co_occurrence_count DESC
LIMIT p_limit;
$$ LANGUAGE sql STABLE;


-- ─── 7e. detect_velocity_spikes ───────────────────────────
-- Entities with mention velocity in last 7d significantly exceeding
-- their 30d average (spike_threshold = multiplier, e.g. 3.0).

CREATE OR REPLACE FUNCTION detect_velocity_spikes(
  p_org_id UUID,
  p_spike_threshold REAL DEFAULT 3.0
)
RETURNS TABLE (
  entity_id UUID,
  entity_name TEXT,
  entity_type TEXT,
  recent_7d_count BIGINT,
  avg_30d_weekly REAL,
  spike_ratio REAL
) AS $$
WITH recent_mentions AS (
  -- Count relationships created in last 7 days per entity
  SELECT
    e.id AS entity_id,
    e.name AS entity_name,
    e.entity_type,
    COUNT(r.id) FILTER (WHERE r.created_at >= now() - interval '7 days') AS recent_7d,
    COUNT(r.id) FILTER (WHERE r.created_at >= now() - interval '30 days') AS total_30d
  FROM entities e
  LEFT JOIN entity_relationships r ON (
    (r.source_entity_id = e.id OR r.target_entity_id = e.id)
    AND r.org_id = p_org_id
  )
  WHERE e.org_id = p_org_id
    AND e.state IN ('active', 'pinned')
  GROUP BY e.id, e.name, e.entity_type
)
SELECT
  rm.entity_id,
  rm.entity_name,
  rm.entity_type,
  rm.recent_7d AS recent_7d_count,
  (rm.total_30d::REAL / 4.0) AS avg_30d_weekly,
  CASE
    WHEN rm.total_30d <= 4 THEN 0  -- not enough data
    ELSE rm.recent_7d::REAL / GREATEST((rm.total_30d::REAL / 4.0), 0.1)
  END AS spike_ratio
FROM recent_mentions rm
WHERE rm.recent_7d > 0
  AND CASE
    WHEN rm.total_30d <= 4 THEN false
    ELSE rm.recent_7d::REAL / GREATEST((rm.total_30d::REAL / 4.0), 0.1) >= p_spike_threshold
  END
ORDER BY spike_ratio DESC;
$$ LANGUAGE sql STABLE;


-- ─── 7f. find_repetitive_relationships ────────────────────
-- Relationship patterns repeated across multiple conversations (for compression).

CREATE OR REPLACE FUNCTION find_repetitive_relationships(
  p_org_id UUID,
  p_min_repetitions INTEGER DEFAULT 5
)
RETURNS TABLE (
  source_entity_id UUID,
  source_entity_name TEXT,
  target_entity_id UUID,
  target_entity_name TEXT,
  relationship_type TEXT,
  repetition_count BIGINT,
  avg_confidence REAL,
  conversation_ids UUID[],
  earliest TIMESTAMPTZ,
  latest TIMESTAMPTZ
) AS $$
SELECT
  r.source_entity_id,
  es.name AS source_entity_name,
  r.target_entity_id,
  et.name AS target_entity_name,
  r.relationship_type,
  COUNT(*) AS repetition_count,
  AVG(r.confidence)::REAL AS avg_confidence,
  ARRAY_AGG(DISTINCT r.source_conversation_id) FILTER (WHERE r.source_conversation_id IS NOT NULL) AS conversation_ids,
  MIN(r.created_at) AS earliest,
  MAX(r.created_at) AS latest
FROM entity_relationships r
JOIN entities es ON es.id = r.source_entity_id
JOIN entities et ON et.id = r.target_entity_id
WHERE r.org_id = p_org_id
  AND r.valid_to IS NULL  -- Only active relationships
GROUP BY r.source_entity_id, es.name, r.target_entity_id, et.name, r.relationship_type
HAVING COUNT(*) >= p_min_repetitions
ORDER BY repetition_count DESC;
$$ LANGUAGE sql STABLE;


-- ─── 7g. apply_decay_cycle ────────────────────────────────
-- Transitions: active → dormant, dormant → archived.
-- Respects pinning, conflicted state, and utility protection.
-- Returns count of entities transitioned.

CREATE OR REPLACE FUNCTION apply_decay_cycle(
  p_org_id UUID
)
RETURNS TABLE (
  transitioned_to_dormant INTEGER,
  transitioned_to_archived INTEGER
) AS $$
DECLARE
  v_dormant_count INTEGER := 0;
  v_archived_count INTEGER := 0;
BEGIN
  -- Active → Dormant:
  -- Not seen in 2× half-life for their class AND not pinned AND utility < 0.2
  WITH to_dormant AS (
    UPDATE entities
    SET
      state = 'dormant',
      last_decay_at = now(),
      updated_at = now()
    WHERE org_id = p_org_id
      AND state = 'active'
      AND is_pinned = false
      AND utility_score < 0.2
      AND last_seen_at < now() - (
        CASE memory_class
          WHEN 'person'    THEN interval '120 days'  -- 2 × 60d
          WHEN 'project'   THEN interval '60 days'   -- 2 × 30d
          WHEN 'decision'  THEN interval '180 days'  -- 2 × 90d
          WHEN 'control'   THEN interval '90 days'   -- 2 × 45d
          WHEN 'team'      THEN interval '120 days'  -- 2 × 60d
          WHEN 'tool'      THEN interval '240 days'  -- 2 × 120d
          WHEN 'vendor'    THEN interval '240 days'  -- 2 × 120d
          WHEN 'framework' THEN interval '240 days'  -- 2 × 120d
          WHEN 'document'  THEN interval '60 days'   -- 2 × 30d
          WHEN 'process'   THEN interval '90 days'   -- 2 × 45d
          ELSE interval '60 days'                     -- 2 × 30d default
        END
      )
    RETURNING id
  )
  SELECT COUNT(*)::INTEGER INTO v_dormant_count FROM to_dormant;

  -- Dormant → Archived:
  -- Dormant > 30 days AND no access AND utility < 0.1
  -- Never archive pinned or conflicted entities
  WITH to_archived AS (
    UPDATE entities
    SET
      state = 'archived',
      last_decay_at = now(),
      updated_at = now()
    WHERE org_id = p_org_id
      AND state = 'dormant'
      AND is_pinned = false
      AND utility_score < 0.1
      AND last_decay_at < now() - interval '30 days'
      AND (last_accessed_at IS NULL OR last_accessed_at < now() - interval '30 days')
    RETURNING id
  )
  SELECT COUNT(*)::INTEGER INTO v_archived_count FROM to_archived;

  RETURN QUERY SELECT v_dormant_count, v_archived_count;
END;
$$ LANGUAGE plpgsql VOLATILE;


-- ─── 7h. upsert_insight_with_dedupe ──────────────────────
-- Insert or bump an insight using idempotency key.
-- On conflict: increment times_triggered, nudge confidence up,
-- refresh expiry, preserve highest utility_score.

CREATE OR REPLACE FUNCTION upsert_insight_with_dedupe(
  p_org_id UUID,
  p_idempotency_key TEXT,
  p_insight_type TEXT,
  p_category TEXT DEFAULT NULL,
  p_summary TEXT DEFAULT '',
  p_confidence REAL DEFAULT 0.5,
  p_entity_ids UUID[] DEFAULT '{}',
  p_evidence JSONB DEFAULT '{}',
  p_action_template JSONB DEFAULT NULL,
  p_source_conversation_id UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO graph_insights (
    org_id, idempotency_key, insight_type, category, summary,
    confidence, related_entity_ids, evidence, action_template,
    source_conversation_id
  )
  VALUES (
    p_org_id, p_idempotency_key, p_insight_type, p_category, p_summary,
    p_confidence, p_entity_ids, p_evidence, p_action_template,
    p_source_conversation_id
  )
  ON CONFLICT (org_id, idempotency_key) DO UPDATE SET
    confidence = LEAST(graph_insights.confidence + 0.05, 1.0),
    times_triggered = graph_insights.times_triggered + 1,
    last_triggered_at = now(),
    expires_at = now() + interval '7 days',
    updated_at = now(),
    -- Keep whichever summary is newer
    summary = EXCLUDED.summary,
    -- Merge evidence (append new evidence into existing)
    evidence = CASE
      WHEN jsonb_typeof(graph_insights.evidence) = 'array'
        AND jsonb_typeof(EXCLUDED.evidence) = 'array'
      THEN graph_insights.evidence || EXCLUDED.evidence
      ELSE EXCLUDED.evidence
    END,
    -- Update action_template if provided
    action_template = COALESCE(EXCLUDED.action_template, graph_insights.action_template),
    -- Preserve active status if currently active, otherwise keep as-is
    status = CASE
      WHEN graph_insights.status IN ('expired', 'dismissed') THEN 'active'
      ELSE graph_insights.status
    END
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql VOLATILE;


-- ============================================================
-- 8. Service role bypass policies for new tables
-- ============================================================
-- The service_role policies above cover ALL operations.
-- For entities table, add a service_role bypass since it didn't have one:

CREATE POLICY "Service role full access entities"
  ON entities FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

CREATE POLICY "Service role full access entity relationships"
  ON entity_relationships FOR ALL USING (
    (SELECT current_setting('request.jwt.claims', true)::json ->> 'role') = 'service_role'
  );

-- ============================================================
-- 9. Extend patrol_findings type constraint for insight-routed findings
-- ============================================================

ALTER TABLE patrol_findings DROP CONSTRAINT IF EXISTS patrol_findings_type_check;
ALTER TABLE patrol_findings ADD CONSTRAINT patrol_findings_type_check CHECK (type IN (
  'deadline_approaching', 'deadline_overdue', 'stale_entity',
  'failing_control', 'unresolved_blocker', 'at_risk_commitment',
  'action_expiring',
  -- New types from insight routing
  'anomaly_detected', 'recurring_pattern', 'opportunity_identified'
));
