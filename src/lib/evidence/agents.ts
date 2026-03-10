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

Rules:
- Every canonical claim or commitment must include at least one evidence item id.
- Reuse known entity ids when provided.
- Emit only evidence-grounded state changes.
- Prefer full canonical names.
- Keep the bundle concise and deduplicated.`

const STATE_SYNTHESIZER_SYSTEM_PROMPT = `You are the state_synthesizer for Axari's evidence graph.

You receive a candidate mutation bundle and current context. Return ONLY valid JSON for the same schema, with source="state_synthesizer".

Rules:
- Merge duplicates and normalize titles.
- Preserve evidence links for every canonical claim.
- Prefer updating existing state over creating parallel objects.
- If a claim changes prior state, still emit the new claim; temporal supersession is handled downstream.
- Keep only net-new or materially updated mutations.`

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
    '## Analyst Bundle',
    JSON.stringify(input.analystBundle, null, 2),
    '',
    '## Context Pack',
    JSON.stringify({
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
    claims: extracted.relationships.map(relationship => ({
      claimKind: 'relationship',
      subjectEntityRef: relationship.source,
      predicate: relationship.type,
      objectEntityRef: relationship.target,
      confidence: relationship.confidence ?? 0.75,
      evidenceItemRefs: claimEvidenceRefs,
      metadata: relationship.properties ?? {},
    })),
    decisionThreads: [],
    commitments: [],
    memories: [],
    vaultDocuments: [],
  })
}
