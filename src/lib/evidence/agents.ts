import { extractEntitiesAndRelationships, EXTRACTOR_MODEL, isOpenAIConfigured } from '@/lib/openai/client'
import { mutationBundleSchema, type MutationBundle } from '@/lib/evidence/schema'
import type { ContextPack, EvidenceItem, SourceArtifact } from '@/lib/evidence/types'

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || ''
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''
const LLM_API_KEY = NVIDIA_API_KEY || OPENROUTER_API_KEY
const LLM_BASE_URL = process.env.LLM_BASE_URL || (NVIDIA_API_KEY
  ? 'https://integrate.api.nvidia.com/v1'
  : 'https://openrouter.ai/api/v1')
const AGENTIC_EVIDENCE_MODEL = process.env.AGENTIC_EVIDENCE_MODEL || EXTRACTOR_MODEL
const EVIDENCE_AGENT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 90_000
const EVIDENCE_AGENT_MAX_TOKENS = Math.max(Number(process.env.AGENTIC_EVIDENCE_MAX_TOKENS) || 6000, 2000)

const CHANNEL_ANALYST_SYSTEM_PROMPT = `You are the channel_analyst for Axari's evidence graph.

Read the source artifact, evidence items, and prior context. Return ONLY valid JSON matching this schema:
{
  "version": 1,
  "source": "channel_analyst",
  "entities": [
    {
      "entityType": "person|project|feature|decision|team|tool|vendor|framework|document|process|customer|metric",
      "name": "string",
      "canonicalName": "string",
      "description": "string",
      "attributes": {}
    }
  ],
  "evidenceItems": [],
  "claims": [
    {
      "claimKind": "relationship|decision|commitment|status|fact",
      "subjectEntityRef": "existing entity id or canonical entity name",
      "predicate": "string",
      "objectEntityRef": "existing entity id or canonical entity name or null",
      "objectValue": "string or null",
      "confidence": 0.0,
      "evidenceStatus": "supported|context_only|manual",
      "evidenceItemRefs": ["MUST be evidence item ids from the input"],
      "manualStateInput": false,
      "validFrom": "ISO timestamp or null",
      "validTo": null,
      "metadata": {}
    }
  ],
  "decisionThreads": [
    {
      "title": "string",
      "status": "open|resolved|superseded|cancelled",
      "relatedEntityRefs": ["entity ids or names"],
      "currentClaimRef": "optional claim predicate or title hint",
      "metadata": {}
    }
  ],
  "commitments": [
    {
      "title": "string",
      "description": "string",
      "status": "open|in_progress|blocked|completed|at_risk|overdue",
      "priority": "P0|P1|P2|P3",
      "dueDate": "date or null",
      "ownerEntityRef": "entity id or name or null",
      "relatedEntityRefs": ["entity ids or names"],
      "decisionThreadTitle": "string or null",
      "evidenceItemRefs": ["evidence item ids"],
      "metadata": {}
    }
  ],
  "memories": [
    {
      "subject": "string",
      "content": "string",
      "category": "meeting_outcome|decision|project_status|relationship|context|fact|blocker|deadline|pattern|strategic_insight|task",
      "confidence": 0.0,
      "relatedEntities": ["entity ids or names"],
      "primaryClaimPredicates": ["string"],
      "metadata": {}
    }
  ],
  "vaultDocuments": []
}

## CRITICAL: Structural Completeness Rules

1. ZERO ORPHAN ENTITIES: Every entity you emit MUST appear in at least one relationship claim (as subjectEntityRef or objectEntityRef). If you extract an entity, you MUST connect it to something. No isolated nodes.

2. TITLE PARSING: The artifact title often encodes the primary parties. Parse it:
   - "X <> Y" means X and Y are the two sides — both MUST be extracted as entities and linked to a project/meeting entity with "participates_in" claims.
   - "X + Y sync" or "X / Y meeting" follows the same pattern.
   - If the title mentions an organization name, that organization MUST have a relationship claim to the meeting/project entity.

3. PARTICIPANT → ORGANIZATION LINKING: When a person attends a meeting, look up which organization they belong to from context or evidence. Create a "participates_in" or "involved_in" relationship claim from that organization to the meeting/project entity. This is how we connect orgs to meetings in the graph.

4. BIDIRECTIONAL AWARENESS: For every "works_at" or "works_on" claim, consider whether the inverse relationship (e.g., organization → project) is also needed. If a person from Company X discusses Project Y, Company X should be linked to Project Y.

5. CONTEXT REUSE: When prior context provides existing entity IDs, ALWAYS use those IDs rather than creating new entities. Check matchedEntities carefully — if "Crane VC" already exists with id "abc123", reference "abc123" not the name string.

## Core Rules
- Every canonical claim or commitment must include at least one evidence item id.
- Reuse known entity ids when provided in matchedEntities.
- Emit only evidence-grounded state changes.
- Prefer full canonical names.
- Keep the bundle concise and deduplicated.
- When in doubt about whether to create a relationship, CREATE IT. Missing edges are worse than redundant ones — downstream dedup handles extras, but nothing recovers missing links.`

const STATE_SYNTHESIZER_SYSTEM_PROMPT = `You are the state_synthesizer for Axari's evidence graph.

You receive a candidate mutation bundle from the channel_analyst and the current context. Your job is to VALIDATE, REPAIR, and REFINE the bundle. Return ONLY valid JSON for the same schema, with source="state_synthesizer".

## CRITICAL: Structural Validation (check BEFORE anything else)

1. ORPHAN ENTITY CHECK: Scan every entity in the analyst bundle. If any entity has ZERO relationship claims (not referenced as subjectEntityRef or objectEntityRef in any claim), you MUST add the missing relationship claims. Common fixes:
   - Organization mentioned in meeting title → add "participates_in" claim to the meeting/project entity
   - Person who attended → add "attended" claim if missing
   - Tool/vendor discussed → add "uses" or "evaluates" claim to the relevant project

2. TITLE-ENTITY COHERENCE: Parse the source artifact title. If the title mentions organizations (e.g. "Crane <> KeyValue"), verify that BOTH organizations appear as entities AND have relationship claims linking them to the meeting/project entity. If not, ADD them.

3. CONTEXT ENTITY LINKING: Check the context pack's matchedEntities. For every matched entity that is clearly relevant to this source artifact but has no claim in the bundle, add a relationship claim connecting it. Use the existing entity ID from context, not a name string.

## Core Rules
- Merge duplicates and normalize titles.
- Preserve evidence links for every canonical claim.
- Prefer updating existing state over creating parallel objects.
- If a claim changes prior state, still emit the new claim; temporal supersession is handled downstream.
- Keep only net-new or materially updated mutations.
- When you add missing relationships, use evidenceItemRefs from the first few evidence items in the bundle — the evidence exists even if the analyst forgot to link it.
- It is ALWAYS better to emit a slightly redundant relationship than to leave entities disconnected. Downstream dedup handles extras.`

export async function runChannelAnalyst(input: {
  artifact: SourceArtifact
  evidenceItems: EvidenceItem[]
  contextPack: ContextPack
  sourceSummary?: Record<string, unknown> | null
}): Promise<MutationBundle | null> {
  const prompt = buildAgentPrompt(input)
  const bundle = await callMutationAgent(CHANNEL_ANALYST_SYSTEM_PROMPT, prompt)
  if (bundle) return bundle

  return fallbackBundleFromExtraction(input)
}

export async function runStateSynthesizer(input: {
  artifact: SourceArtifact
  evidenceItems: EvidenceItem[]
  contextPack: ContextPack
  analystBundle: MutationBundle
  sourceSummary?: Record<string, unknown> | null
}): Promise<MutationBundle | null> {
  const prompt = [
    '## Source Artifact',
    JSON.stringify(input.artifact, null, 2),
    '',
    '## Evidence Items (first 10 IDs for linking)',
    JSON.stringify(input.evidenceItems.slice(0, 10).map(e => ({ id: e.id, text: e.text.slice(0, 120) })), null, 2),
    '',
    '## Analyst Bundle',
    JSON.stringify(input.analystBundle, null, 2),
    '',
    '## Context Pack',
    JSON.stringify({
      matchedEntities: input.contextPack.matchedEntities.slice(0, 30),
      matchedEntityIds: input.contextPack.matchedEntityIds,
      activeClaims: input.contextPack.activeClaims.slice(0, 20),
      commitments: input.contextPack.commitments.slice(0, 12),
      decisionThreads: input.contextPack.decisionThreads.slice(0, 12),
      memories: input.contextPack.memories.slice(0, 10),
    }, null, 2),
  ].join('\n')

  const synthesized = await callMutationAgent(STATE_SYNTHESIZER_SYSTEM_PROMPT, prompt)
  return synthesized ?? input.analystBundle
}

async function callMutationAgent(systemPrompt: string, userPrompt: string): Promise<MutationBundle | null> {
  if (!isOpenAIConfigured() || !LLM_API_KEY) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EVIDENCE_AGENT_TIMEOUT_MS)

  try {
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Axari Evidence Graph',
      },
      body: JSON.stringify({
        model: AGENTIC_EVIDENCE_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt.slice(0, 75_000) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: EVIDENCE_AGENT_MAX_TOKENS,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[evidence-agents] Agent call failed:', response.status, errorText.slice(0, 300))
      return null
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) return null

    const parsed = mutationBundleSchema.safeParse(JSON.parse(content))
    if (!parsed.success) {
      console.error('[evidence-agents] Invalid mutation bundle:', parsed.error.flatten())
      return null
    }

    return parsed.data
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      console.error('[evidence-agents] Agent error:', error)
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function buildAgentPrompt(input: {
  artifact: SourceArtifact
  evidenceItems: EvidenceItem[]
  contextPack: ContextPack
  sourceSummary?: Record<string, unknown> | null
}): string {
  return [
    '## Source Artifact',
    JSON.stringify(input.artifact, null, 2),
    '',
    input.sourceSummary
      ? `## Source Summary\n${JSON.stringify(input.sourceSummary, null, 2)}\n`
      : '',
    '## Evidence Items',
    JSON.stringify(input.evidenceItems.slice(0, 200), null, 2),
    '',
    '## Prior Context',
    JSON.stringify({
      matchedEntities: input.contextPack.matchedEntities,
      activeClaims: input.contextPack.activeClaims.slice(0, 20),
      commitments: input.contextPack.commitments.slice(0, 12),
      decisionThreads: input.contextPack.decisionThreads.slice(0, 12),
      memories: input.contextPack.memories.slice(0, 10),
      recentArtifacts: input.contextPack.recentArtifacts.slice(0, 10),
      vaultDocuments: input.contextPack.vaultDocuments.slice(0, 10).map(doc => ({
        path: doc.path,
        title: doc.title,
      })),
    }, null, 2),
  ].join('\n')
}

async function fallbackBundleFromExtraction(input: {
  artifact: SourceArtifact
  evidenceItems: EvidenceItem[]
  sourceSummary?: Record<string, unknown> | null
}): Promise<MutationBundle> {
  const extractionInput = [
    input.artifact.title,
    JSON.stringify(input.sourceSummary ?? {}, null, 2),
    ...input.evidenceItems.map(item => `${item.authorName ?? 'Unknown'}: ${item.text}`),
  ].join('\n').slice(0, 50_000)

  const extracted = await extractEntitiesAndRelationships(extractionInput)

  const claimEvidenceRefs = input.evidenceItems.slice(0, 3).map(item => item.id)

  const claims = extracted.relationships.map(relationship => ({
    claimKind: 'relationship' as const,
    subjectEntityRef: relationship.source,
    predicate: relationship.type,
    objectEntityRef: relationship.target,
    confidence: relationship.confidence ?? 0.75,
    evidenceItemRefs: claimEvidenceRefs,
    metadata: relationship.properties ?? {},
  }))

  // Parse title for implied organization relationships (e.g. "Crane <> KeyValue")
  const titleParties = parseTitleParties(input.artifact.title)
  const entityNames = new Set(extracted.entities.map(e => e.name.toLowerCase()))
  const claimRefs = new Set(claims.flatMap(c =>
    [c.subjectEntityRef?.toLowerCase(), c.objectEntityRef?.toLowerCase()].filter(Boolean)
  ))

  for (const party of titleParties) {
    // Check if this party exists as an entity but has no relationship to the artifact title entity
    const partyLower = party.toLowerCase()
    const hasEntity = extracted.entities.some(e => e.name.toLowerCase().includes(partyLower))
    const titleEntity = extracted.entities.find(e =>
      e.name.toLowerCase() === input.artifact.title.toLowerCase()
    )

    if (hasEntity && titleEntity) {
      const matchedEntity = extracted.entities.find(e => e.name.toLowerCase().includes(partyLower))
      if (matchedEntity) {
        // Check if there's already a claim connecting them
        const alreadyLinked = claims.some(c =>
          (c.subjectEntityRef?.toLowerCase() === matchedEntity.name.toLowerCase() && c.objectEntityRef?.toLowerCase() === titleEntity.name.toLowerCase()) ||
          (c.objectEntityRef?.toLowerCase() === matchedEntity.name.toLowerCase() && c.subjectEntityRef?.toLowerCase() === titleEntity.name.toLowerCase())
        )
        if (!alreadyLinked) {
          claims.push({
            claimKind: 'relationship',
            subjectEntityRef: matchedEntity.name,
            predicate: 'participates_in',
            objectEntityRef: titleEntity.name,
            confidence: 0.9,
            evidenceItemRefs: claimEvidenceRefs,
            metadata: {},
          })
        }
      }
    }
  }

  return mutationBundleSchema.parse({
    version: 1,
    source: 'channel_analyst',
    entities: extracted.entities.map(entity => ({
      entityType: entity.type,
      name: entity.name,
      canonicalName: entity.name.toLowerCase().trim(),
      description: entity.description ?? null,
      attributes: entity.attributes ?? {},
    })),
    claims,
    decisionThreads: [],
    commitments: [],
    memories: [],
    vaultDocuments: [],
  })
}

/**
 * Parse the artifact title for implied parties.
 * "Crane <> KeyValue" → ["Crane", "KeyValue"]
 * "Sales + Engineering Sync" → ["Sales", "Engineering"]
 * "Ali / Prashanth 1:1" → ["Ali", "Prashanth"]
 */
function parseTitleParties(title: string): string[] {
  // Try common separator patterns
  const separators = [/\s*<>\s*/, /\s*\+\s*/, /\s*\/\s*/, /\s*vs\.?\s*/i, /\s*&\s*/]
  for (const sep of separators) {
    if (sep.test(title)) {
      return title.split(sep).map(s => s.trim()).filter(s => s.length > 0 && s.length < 60)
    }
  }
  return []
}
