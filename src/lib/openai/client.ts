// ─── LLM Client (NVIDIA NIM / OpenRouter) ───────────────────────────────────
// Direct fetch() calls for entity extraction and embeddings.
// No npm dependency — just HTTP. Used by the background extraction pipeline
// and memory tools.
//
// Chat completions: NVIDIA NIM (primary) → OpenRouter (fallback) → OpenAI (fallback)
// Embeddings: OpenRouter (primary, 1536-dim for DB compat) → OpenAI (fallback)

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || ''
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''

// Chat completions config (extraction)
const LLM_API_KEY = NVIDIA_API_KEY || OPENROUTER_API_KEY
const LLM_BASE_URL = process.env.LLM_BASE_URL || (NVIDIA_API_KEY
  ? 'https://integrate.api.nvidia.com/v1'
  : 'https://openrouter.ai/api/v1')
export const EXTRACTOR_MODEL = process.env.EXTRACTOR_MODEL || (NVIDIA_API_KEY
  ? 'qwen/qwen3.5-397b-a17b'
  : 'qwen/qwen3.5-397b-a17b')

// Fallback model for extraction when primary model times out or returns empty.
// google/gemini-2.0-flash is fast (~5-15s), cheap, and reliable for JSON extraction.
const FALLBACK_EXTRACTOR_MODEL = process.env.FALLBACK_EXTRACTOR_MODEL || 'google/gemini-2.0-flash-001'

// Timeout for LLM extraction calls (ms). Default 90s — well under Vercel's 300s limit.
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 90_000

// Embeddings config (separate — DB requires 1536-dim vectors, NVIDIA only does 1024)
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || OPENROUTER_API_KEY
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || 'https://openrouter.ai/api/v1'
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small'

// ─── Types ───────────────────────────────────────────────────────────────

export type EntityType =
  | 'person' | 'project' | 'feature' | 'decision' | 'team'
  | 'tool' | 'vendor' | 'framework' | 'document' | 'process'
  | 'customer' | 'metric'

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

export interface EntityMatchLLMDecision {
  action: 'match' | 'create_new' | 'uncertain'
  entityId?: string
  confidence?: number
  reasoning?: string
}

// ─── Extraction System Prompt ────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT = `You are an entity and relationship extractor for a Senior Product Manager's executive workflow system. Extract structured entities and relationships from the given text and any integration data.

## Entity Types
- person: People mentioned (team members, stakeholders, vendors, email senders/recipients, meeting attendees)
- project: Projects, initiatives, programs, epics
- feature: Product features, user stories, capabilities (e.g., "dark mode", "SSO integration", "onboarding flow")
- decision: Key product decisions made or pending
- team: Teams or departments
- tool: Software tools or platforms
- vendor: Third-party vendors or service providers
- customer: Customers, user segments, accounts (e.g., "Enterprise tier", "Acme Corp")
- metric: Product metrics, KPIs (e.g., "DAU", "NPS score", "conversion rate")
- framework: Product frameworks or methodologies (e.g., "RICE scoring", "Jobs-to-be-Done")
- document: Documents, PRDs, specs, reports
- process: Business processes or workflows

## Relationship Types
Use clear verb-based types: manages, owns, reports_to, depends_on, blocks, part_of, uses, decided, assigned_to, works_on, reviewed_by, impacts, tracks, prioritized, shipped, requested_by, emailed, mentioned_in, attended, scheduled_with, requested, follows_up_on, organized, etc.

## Integration Data Patterns
When the input includes "## Integration Data" sections, extract entities from them:

**Emails**: Extract senders and recipients as persons, subjects as projects/topics, action items as decisions, deadlines as attributes on related entities. Relationships: "emailed", "requested", "follows_up_on"

**Calendar Events**: Extract event titles as projects/meetings, attendees as persons, recurring meetings as processes. Relationships: "attended", "scheduled_with", "organized"

**Slack Messages**: Extract authors as persons, channel topics as projects, decisions made in threads, action items assigned. Relationships: "mentioned_in", "decided", "assigned_to"

**Product/Platform Data**: Extract feature names as features, customer names as customers, metric names as metrics, failing monitors or quality issues with descriptions. Relationships: "impacts", "part_of", "requested_by"

## Rules
- **CRITICAL: Use full canonical names.** Always use the most complete name available: "Sarah Chen" not "Sarah" or "S. Chen", "KeyValue Systems" not "KeyValue", "Muhammadali Bayramov" not "Muhammadali"
- **CRITICAL: One entity type per entity.** Do not extract the same real-world entity under multiple types. A company like "Axari" should be ONE entity (pick the most relevant type — usually "vendor" or "project"), not separate "vendor", "tool", and "team" entries
- For email addresses, extract the person name AND store the email in attributes: {"email": "sarah@example.com"}
- Only extract entities that are clearly identifiable — skip vague references like "the team" or "the project"
- Relationships must reference entities by their exact name from the entities list
- Confidence: 1.0 for explicit (email sender/recipient, calendar attendee), 0.7-0.9 for inferred
- Keep descriptions concise (1 sentence max)
- If the text has no extractable entities, return empty arrays
- Prioritize actionable entities: people with responsibilities, projects with deadlines, features in development, customers with requests, metrics with changes, decisions pending action
- Every entity MUST have at least one relationship. Do not extract standalone entities with no connections

Respond with valid JSON matching this schema:
{
  "entities": [{ "name": "string", "type": "string", "description": "string", "attributes": {} }],
  "relationships": [{ "source": "string", "target": "string", "type": "string", "properties": {}, "confidence": 1.0 }]
}`

const ENTITY_RESOLUTION_SYSTEM_PROMPT = `You resolve whether a newly extracted entity refers to an existing knowledge-graph entity.

Rules:
- Prefer matching only when evidence is strong.
- Exact email identity is definitive.
- For people, minor spelling drift is acceptable only if the full name clearly refers to the same person.
- Do not merge different people who only share a first name.
- For organizations, treat suffix variants like "VC" and "Ventures" as possibly the same organization if the base name is the same.
- If uncertain, return "uncertain" instead of forcing a match.

Respond with valid JSON:
{
  "action": "match" | "create_new" | "uncertain",
  "entityId": "existing entity id if action=match",
  "confidence": 0.0,
  "reasoning": "short explanation"
}`

// ─── API Functions ───────────────────────────────────────────────────────

/**
 * Extract entities and relationships from text using an LLM.
 * Primary: uses configured provider (NVIDIA NIM or OpenRouter).
 * Fallback: always uses OpenRouter with a fast model if primary fails/returns empty.
 * Includes 90s timeout per call to prevent Vercel function exhaustion.
 */
export async function extractEntitiesAndRelationships(text: string): Promise<ExtractionResult> {
  if (!LLM_API_KEY) {
    return { entities: [], relationships: [] }
  }

  // Skip very short or empty text
  if (!text || text.trim().length < 20) {
    return { entities: [], relationships: [] }
  }

  // Try primary model first
  let primaryResult: ExtractionResult
  try {
    primaryResult = await callExtractionModel({
      model: EXTRACTOR_MODEL,
      apiKey: LLM_API_KEY,
      baseUrl: LLM_BASE_URL,
      text,
    })
    if (primaryResult.entities.length > 0) {
      return primaryResult
    }
  } catch (err) {
    console.error(`[LLM Client] Primary model ${EXTRACTOR_MODEL} threw:`, (err as Error).message)
    primaryResult = { entities: [], relationships: [] }
  }

  // Primary returned empty or threw — retry with fallback model via OpenRouter
  if (OPENROUTER_API_KEY && FALLBACK_EXTRACTOR_MODEL && FALLBACK_EXTRACTOR_MODEL !== EXTRACTOR_MODEL) {
    console.warn(
      `[LLM Client] Primary model ${EXTRACTOR_MODEL} returned 0 entities — ` +
      `retrying with fallback ${FALLBACK_EXTRACTOR_MODEL} via OpenRouter`
    )
    try {
      const fallbackResult = await callExtractionModel({
        model: FALLBACK_EXTRACTOR_MODEL,
        apiKey: OPENROUTER_API_KEY, // Always use OpenRouter for fallback
        baseUrl: 'https://openrouter.ai/api/v1',
        text,
      })
      if (fallbackResult.entities.length > 0) {
        return fallbackResult
      }
      console.error(`[LLM Client] Fallback model ${FALLBACK_EXTRACTOR_MODEL} also returned 0 entities`)
    } catch (err) {
      console.error(`[LLM Client] Fallback model ${FALLBACK_EXTRACTOR_MODEL} threw:`, (err as Error).message)
    }
  }

  return primaryResult
}

interface ExtractionModelConfig {
  model: string
  apiKey: string
  baseUrl: string
  text: string
}

/**
 * Call a specific model for entity extraction with timeout and error handling.
 */
async function callExtractionModel(config: ExtractionModelConfig): Promise<ExtractionResult> {
  const { model, apiKey, baseUrl, text } = config
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

  try {
    const startMs = Date.now()
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Captain Knowledge Graph',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 4000,
      }),
      signal: controller.signal,
    })

    const elapsed = Date.now() - startMs

    if (!response.ok) {
      const err = await response.text()
      console.error(`[LLM Client] ${model} extraction failed (${response.status}, ${elapsed}ms): ${err.slice(0, 300)}`)
      throw new Error(`LLM extraction failed (${response.status}): ${err}`)
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content

    if (!content) {
      console.warn(
        `[LLM Client] ${model} returned empty content (${elapsed}ms). ` +
        `finish_reason=${data.choices?.[0]?.finish_reason ?? 'unknown'}, ` +
        `usage=${JSON.stringify(data.usage ?? null)}`
      )
      return { entities: [], relationships: [], usage: data.usage }
    }

    let parsed: { entities: ExtractedEntity[]; relationships: ExtractedRelationship[] }
    try {
      parsed = JSON.parse(content)
    } catch {
      console.error(
        `[LLM Client] ${model} returned non-JSON (${elapsed}ms): ${content.slice(0, 300)}`
      )
      return { entities: [], relationships: [], usage: data.usage }
    }

    // Validate entity types
    const validTypes = new Set(['person', 'project', 'feature', 'decision', 'team', 'tool', 'vendor', 'framework', 'document', 'process', 'customer', 'metric'])
    parsed.entities = (parsed.entities || []).filter(e => validTypes.has(e.type))
    parsed.relationships = parsed.relationships || []

    console.log(
      `[LLM Client] ${model} extracted ${parsed.entities.length} entities, ` +
      `${parsed.relationships.length} relationships (${elapsed}ms)`
    )

    return {
      entities: parsed.entities,
      relationships: parsed.relationships,
      usage: data.usage,
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      console.error(`[LLM Client] ${model} timed out after ${LLM_TIMEOUT_MS}ms`)
      return { entities: [], relationships: [] }
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Generate a vector embedding for text.
 * Uses OpenRouter for embeddings (1536-dim, matching DB vector columns).
 * Returns a 1536-dim float array.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!EMBEDDING_API_KEY) return null
  if (!text || text.trim().length < 3) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000) // 30s timeout for embeddings

  try {
    const response = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${EMBEDDING_API_KEY}`,
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Captain Knowledge Graph',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000), // trim to model limit
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const err = await response.text()
      console.error(`Embedding failed (${response.status}): ${err}`)
      return null
    }

    const data = await response.json()
    return data.data?.[0]?.embedding ?? null
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      console.error('[LLM Client] Embedding timed out after 30s')
      return null
    }
    console.error('[LLM Client] Embedding error:', error)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Ask the configured LLM to resolve a candidate entity against ambiguous existing entities.
 */
export async function resolveEntityMatchWithLLM(input: {
  candidate: Record<string, unknown>
  candidates: Array<Record<string, unknown>>
}): Promise<EntityMatchLLMDecision | null> {
  if (!LLM_API_KEY || input.candidates.length === 0) return null

  const body = JSON.stringify({
    candidate: input.candidate,
    candidates: input.candidates,
  })

  const attempt = async (model: string, apiKey: string, baseUrl: string): Promise<EntityMatchLLMDecision | null> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(LLM_TIMEOUT_MS, 30_000))

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
          'X-Title': 'Captain Entity Resolution',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: ENTITY_RESOLUTION_SYSTEM_PROMPT },
            { role: 'user', content: body },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 800,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        return null
      }

      const data = await response.json()
      const content = data.choices?.[0]?.message?.content
      if (!content) return null

      const parsed = JSON.parse(content) as EntityMatchLLMDecision
      if (!parsed.action) return null
      return parsed
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  const primary = await attempt(EXTRACTOR_MODEL, LLM_API_KEY, LLM_BASE_URL)
  if (primary) return primary

  if (OPENROUTER_API_KEY && FALLBACK_EXTRACTOR_MODEL && FALLBACK_EXTRACTOR_MODEL !== EXTRACTOR_MODEL) {
    return attempt(FALLBACK_EXTRACTOR_MODEL, OPENROUTER_API_KEY, 'https://openrouter.ai/api/v1')
  }

  return null
}

/**
 * Check if the LLM API key is configured (NVIDIA NIM or OpenRouter).
 */
export function isOpenAIConfigured(): boolean {
  return !!(NVIDIA_API_KEY || OPENROUTER_API_KEY)
}
