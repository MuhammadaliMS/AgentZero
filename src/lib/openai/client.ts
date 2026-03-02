// ─── LLM Client (OpenRouter) ────────────────────────────────────────────────
// Direct fetch() calls to OpenRouter (OpenAI-compatible) for entity extraction
// and embeddings. No npm dependency — just HTTP. Used by the background
// extraction pipeline and memory tools.
//
// OpenRouter routes requests to 100+ LLMs — change EXTRACTOR_MODEL to use
// any supported model (e.g., google/gemini-flash-1.5, meta-llama/llama-3-8b).

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''
const EXTRACTOR_MODEL = process.env.EXTRACTOR_MODEL || 'x-ai/grok-4.1-fast'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small'
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1'

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

Respond with valid JSON matching this schema:
{
  "entities": [{ "name": "string", "type": "string", "description": "string", "attributes": {} }],
  "relationships": [{ "source": "string", "target": "string", "type": "string", "properties": {}, "confidence": 1.0 }]
}`

// ─── API Functions ───────────────────────────────────────────────────────

/**
 * Extract entities and relationships from text using a cheap LLM via OpenRouter.
 * Returns structured data suitable for graph insertion.
 */
export async function extractEntitiesAndRelationships(text: string): Promise<ExtractionResult> {
  if (!OPENROUTER_API_KEY) {
    return { entities: [], relationships: [] }
  }

  // Skip very short or empty text
  if (!text || text.trim().length < 20) {
    return { entities: [], relationships: [] }
  }

  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      'X-Title': 'Captain Knowledge Graph',
    },
    body: JSON.stringify({
      model: EXTRACTOR_MODEL,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 2000,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`LLM extraction failed (${response.status}): ${err}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) {
    return { entities: [], relationships: [] }
  }

  let parsed: { entities: ExtractedEntity[]; relationships: ExtractedRelationship[] }
  try {
    parsed = JSON.parse(content)
  } catch {
    console.error('[LLM Client] Failed to parse extraction JSON:', content.slice(0, 200))
    return { entities: [], relationships: [] }
  }

  // Validate entity types
  const validTypes = new Set(['person', 'project', 'control', 'decision', 'team', 'tool', 'vendor', 'framework', 'document', 'process'])
  parsed.entities = (parsed.entities || []).filter(e => validTypes.has(e.type))
  parsed.relationships = parsed.relationships || []

  return {
    entities: parsed.entities,
    relationships: parsed.relationships,
    usage: data.usage,
  }
}

/**
 * Generate a vector embedding for text using OpenRouter embeddings API.
 * Returns a 1536-dim float array.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!OPENROUTER_API_KEY) return null
  if (!text || text.trim().length < 3) return null

  const response = await fetch(`${LLM_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
      'X-Title': 'Captain Knowledge Graph',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 8000), // trim to model limit
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    console.error(`Embedding failed (${response.status}): ${err}`)
    return null
  }

  const data = await response.json()
  return data.data?.[0]?.embedding ?? null
}

/**
 * Check if the LLM API key is configured (OpenRouter).
 */
export function isOpenAIConfigured(): boolean {
  return !!OPENROUTER_API_KEY
}
