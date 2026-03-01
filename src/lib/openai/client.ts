// ─── Minimal OpenAI Client ───────────────────────────────────────────────
// Direct fetch() calls to OpenAI API for entity extraction and embeddings.
// No npm dependency — just HTTP. Used by the background extraction pipeline.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const EXTRACTOR_MODEL = process.env.EXTRACTOR_MODEL || 'gpt-4o-mini'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small'
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'

// ─── Types ───────────────────────────────────────────────────────────────

export type EntityType =
  | 'person' | 'project' | 'control' | 'decision' | 'team'
  | 'tool' | 'vendor' | 'framework' | 'document' | 'process'

export interface ExtractedEntity {
  name: string
  type: EntityType
  description?: string
  attributes?: Record<string, unknown>
}

export interface ExtractedRelationship {
  source: string
  target: string
  type: string
  properties?: Record<string, unknown>
  confidence?: number
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  relationships: ExtractedRelationship[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

// ─── Extraction System Prompt ────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are an entity and relationship extractor for a CISO's executive workflow system. Extract structured entities and relationships from the given text.

## Entity Types
- person: People mentioned (team members, stakeholders, vendors)
- project: Projects, initiatives, programs
- control: Security/compliance controls (e.g., "access reviews", "MFA enforcement")
- decision: Key decisions made or pending
- team: Teams or departments
- tool: Software tools or platforms
- vendor: Third-party vendors or service providers
- framework: Compliance frameworks (SOC2, ISO 27001, NIST, etc.)
- document: Documents, reports, policies
- process: Business processes or workflows

## Relationship Types
Use clear verb-based types: manages, owns, reports_to, depends_on, blocks, part_of, uses, decided, assigned_to, works_on, reviewed_by, audited_by, etc.

## Rules
- Use full canonical names (e.g., "Sarah Chen" not "Sarah" or "S. Chen")
- Only extract entities that are clearly identifiable — skip vague references
- Relationships must reference entities by their exact name from the entities list
- Confidence: 1.0 for explicit statements, 0.7-0.9 for inferred relationships
- Keep descriptions concise (1 sentence max)
- If the text is a simple greeting or has no extractable entities, return empty arrays

Respond with JSON only, no explanation.`

const EXTRACTION_SCHEMA = {
  type: 'object' as const,
  properties: {
    entities: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          type: { type: 'string' as const, enum: ['person', 'project', 'control', 'decision', 'team', 'tool', 'vendor', 'framework', 'document', 'process'] },
          description: { type: 'string' as const },
          attributes: { type: 'object' as const },
        },
        required: ['name', 'type'],
      },
    },
    relationships: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          source: { type: 'string' as const },
          target: { type: 'string' as const },
          type: { type: 'string' as const },
          properties: { type: 'object' as const },
          confidence: { type: 'number' as const },
        },
        required: ['source', 'target', 'type'],
      },
    },
  },
  required: ['entities', 'relationships'],
}

// ─── API Functions ───────────────────────────────────────────────────────

/**
 * Extract entities and relationships from text using a cheap LLM.
 * Returns structured data suitable for graph insertion.
 */
export async function extractEntitiesAndRelationships(text: string): Promise<ExtractionResult> {
  if (!OPENAI_API_KEY) {
    return { entities: [], relationships: [] }
  }

  // Skip very short or empty text
  if (!text || text.trim().length < 20) {
    return { entities: [], relationships: [] }
  }

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EXTRACTOR_MODEL,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'extraction',
          strict: true,
          schema: EXTRACTION_SCHEMA,
        },
      },
      temperature: 0,
      max_tokens: 2000,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenAI extraction failed (${response.status}): ${err}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) {
    return { entities: [], relationships: [] }
  }

  const parsed = JSON.parse(content) as { entities: ExtractedEntity[]; relationships: ExtractedRelationship[] }

  // Validate entity types
  const validTypes = new Set(['person', 'project', 'control', 'decision', 'team', 'tool', 'vendor', 'framework', 'document', 'process'])
  parsed.entities = parsed.entities.filter(e => validTypes.has(e.type))

  return {
    entities: parsed.entities,
    relationships: parsed.relationships,
    usage: data.usage,
  }
}

/**
 * Generate a vector embedding for text using OpenAI embeddings API.
 * Returns a 1536-dim float array.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY) return null
  if (!text || text.trim().length < 3) return null

  const response = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000), // trim to model limit
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenAI embedding failed (${response.status}): ${err}`)
  }

  const data = await response.json()
  return data.data?.[0]?.embedding ?? null
}

/**
 * Check if the OpenAI API key is configured.
 */
export function isOpenAIConfigured(): boolean {
  return !!OPENAI_API_KEY
}
