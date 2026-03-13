import { z } from 'zod'

import { EXTRACTOR_MODEL } from '@/lib/openai/client'
import type {
  DecisionThreadRecord,
  EvidenceItem,
  SourceArtifact,
  VaultCitation,
  VaultManualSection,
  VaultSection,
} from '@/lib/evidence/types'

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || ''
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''
const LLM_API_KEY = NVIDIA_API_KEY || OPENROUTER_API_KEY
const LLM_BASE_URL = process.env.LLM_BASE_URL || (NVIDIA_API_KEY
  ? 'https://integrate.api.nvidia.com/v1'
  : 'https://openrouter.ai/api/v1')
const VAULT_WRITER_TIMEOUT_MS = Number(process.env.VAULT_WRITER_TIMEOUT_MS) || 180_000
const VAULT_WRITER_MAX_TOKENS = Math.max(Number(process.env.VAULT_WRITER_MAX_TOKENS) || 5000, 1000)
const VAULT_WRITER_MODEL = process.env.AGENTIC_VAULT_MODEL || EXTRACTOR_MODEL || 'moonshotai/kimi-k2.5'

const sourceInterpretationSchema = z.object({
  whatHappened: z.string().min(1),
  whatMatters: z.string().min(1),
  whatChanged: z.string().min(1),
})

const entityInterpretationSchema = z.object({
  currentState: z.string().min(1),
  recentChanges: z.string().min(1),
  openQuestions: z.string().min(1),
  whyItMatters: z.string().min(1),
})

const narrativeInterpretationSchema = z.object({
  currentState: z.string().min(1),
  changesSinceLastUpdate: z.string().min(1),
  keyRisks: z.string().min(1),
  likelyNextSteps: z.string().min(1),
})

function buildEvidenceExcerpt(evidenceItems: EvidenceItem[], limit = 8): string {
  return evidenceItems
    .slice(0, limit)
    .map((item) => `- ${item.authorName ?? 'Unknown'} @ ${item.happenedAt ?? item.sequenceNo}: ${item.text.slice(0, 280)}`)
    .join('\n')
}

async function callVaultWriter<T>(args: {
  systemPrompt: string
  userPrompt: string
  schema: z.ZodSchema<T>
}): Promise<T | null> {
  if (!LLM_API_KEY) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VAULT_WRITER_TIMEOUT_MS)

  try {
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Axari Vault Author',
      },
      body: JSON.stringify({
        model: VAULT_WRITER_MODEL,
        messages: [
          { role: 'system', content: args.systemPrompt },
          { role: 'user', content: args.userPrompt.slice(0, 20_000) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: VAULT_WRITER_MAX_TOKENS,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      return null
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) return null

    const parsed = args.schema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function writeSourceInterpretation(input: {
  artifact: SourceArtifact
  evidenceItems: EvidenceItem[]
  previousSummary?: string | null
}): Promise<VaultSection[]> {
  const result = await callVaultWriter({
    systemPrompt: `You are vault_source_interpreter for Axari.
Write concise, grounded sections for a source document. Return JSON:
{"whatHappened":"...","whatMatters":"...","whatChanged":"..."}
Use only the provided source facts and evidence. Mention uncertainty plainly.`,
    userPrompt: [
      `Artifact title: ${input.artifact.title}`,
      `Channel: ${input.artifact.channel}`,
      `Started: ${input.artifact.startedAt ?? 'Unknown'}`,
      input.previousSummary ? `Previous summary: ${input.previousSummary}` : '',
      'Evidence excerpts:',
      buildEvidenceExcerpt(input.evidenceItems),
    ].filter(Boolean).join('\n\n'),
    schema: sourceInterpretationSchema,
  })

  if (!result) return []

  return [
    {
      id: 'what-happened',
      title: 'What happened',
      kind: 'summary',
      content: result.whatHappened,
      generated: true,
      editable: false,
    },
    {
      id: 'what-matters',
      title: 'What matters',
      kind: 'summary',
      content: result.whatMatters,
      generated: true,
      editable: false,
    },
    {
      id: 'what-changed',
      title: 'What changed from prior related source',
      kind: 'changes',
      content: result.whatChanged,
      generated: true,
      editable: false,
    },
  ]
}

export async function writeEntitySynthesis(input: {
  title: string
  entityType?: string
  claims: Array<Record<string, unknown>>
  commitments: Array<Record<string, unknown>>
  decisionThreads: Array<Record<string, unknown>>
  evidenceItems: EvidenceItem[]
  previousSummary?: string | null
  manualSections?: Record<string, VaultManualSection>
}): Promise<VaultSection[]> {
  const result = await callVaultWriter({
    systemPrompt: `You are vault_entity_synthesizer for Axari.
Write concise, high-signal interpretation for an entity or work document. Return JSON:
{"currentState":"...","recentChanges":"...","openQuestions":"...","whyItMatters":"..."}
Ground everything in the provided facts and evidence. Do not invent fields.`,
    userPrompt: [
      `Title: ${input.title}`,
      input.entityType ? `Type: ${input.entityType}` : '',
      input.previousSummary ? `Previous summary: ${input.previousSummary}` : '',
      Object.values(input.manualSections ?? {}).some(section => section.content.trim())
        ? `Manual notes:\n${Object.values(input.manualSections ?? {}).map(section => `${section.title}: ${section.content}`).join('\n')}`
        : '',
      'Claims:',
      JSON.stringify(input.claims.slice(0, 12), null, 2),
      'Commitments:',
      JSON.stringify(input.commitments.slice(0, 8), null, 2),
      'Decision threads:',
      JSON.stringify(input.decisionThreads.slice(0, 8), null, 2),
      'Evidence excerpts:',
      buildEvidenceExcerpt(input.evidenceItems),
    ].filter(Boolean).join('\n\n'),
    schema: entityInterpretationSchema,
  })

  if (!result) return []

  return [
    {
      id: 'current-state',
      title: 'Current state',
      kind: 'summary',
      content: result.currentState,
      generated: true,
      editable: false,
    },
    {
      id: 'recent-changes',
      title: 'Recent changes',
      kind: 'changes',
      content: result.recentChanges,
      generated: true,
      editable: false,
    },
    {
      id: 'open-questions',
      title: 'Open questions',
      kind: 'summary',
      content: result.openQuestions,
      generated: true,
      editable: false,
    },
    {
      id: 'why-it-matters',
      title: 'Why this matters',
      kind: 'summary',
      content: result.whyItMatters,
      generated: true,
      editable: false,
    },
  ]
}

export async function writeNarrativeAuthor(input: {
  title: string
  narrativeType: 'account' | 'relationship' | 'initiative' | 'brief'
  summaryFacts: string[]
  evidenceItems: EvidenceItem[]
  recentArtifacts: Array<Record<string, unknown>>
  previousSummary?: string | null
  manualSections?: Record<string, VaultManualSection>
}): Promise<VaultSection[]> {
  const result = await callVaultWriter({
    systemPrompt: `You are vault_narrative_author for Axari.
Write a compact narrative document. Return JSON:
{"currentState":"...","changesSinceLastUpdate":"...","keyRisks":"...","likelyNextSteps":"..."}
Explain what is happening now, what changed, what could go wrong, and what should happen next. Stay grounded.`,
    userPrompt: [
      `Title: ${input.title}`,
      `Narrative type: ${input.narrativeType}`,
      input.previousSummary ? `Previous summary: ${input.previousSummary}` : '',
      Object.values(input.manualSections ?? {}).some(section => section.content.trim())
        ? `Manual notes:\n${Object.values(input.manualSections ?? {}).map(section => `${section.title}: ${section.content}`).join('\n')}`
        : '',
      'Summary facts:',
      input.summaryFacts.map((fact) => `- ${fact}`).join('\n'),
      'Recent artifacts:',
      JSON.stringify(input.recentArtifacts.slice(0, 6), null, 2),
      'Evidence excerpts:',
      buildEvidenceExcerpt(input.evidenceItems),
    ].filter(Boolean).join('\n\n'),
    schema: narrativeInterpretationSchema,
  })

  if (!result) return []

  const citations: VaultCitation[] = input.evidenceItems.slice(0, 4).map((item) => ({
    label: item.authorName ? `${item.authorName} evidence` : 'Evidence',
    linkKind: 'evidence_item',
    targetId: item.id,
    happenedAt: item.happenedAt,
  }))

  return [
    {
      id: 'current-state',
      title: input.narrativeType === 'brief' ? 'Today at a glance' : 'Current state',
      kind: input.narrativeType === 'brief' ? 'brief' : 'narrative',
      content: result.currentState,
      generated: true,
      editable: false,
      citations,
    },
    {
      id: 'changes-since-last-update',
      title: 'Changes since last update',
      kind: 'changes',
      content: result.changesSinceLastUpdate,
      generated: true,
      editable: false,
      citations,
    },
    {
      id: 'key-risks',
      title: 'Key risks',
      kind: 'summary',
      content: result.keyRisks,
      generated: true,
      editable: false,
    },
    {
      id: 'likely-next-steps',
      title: 'Likely next steps',
      kind: 'work',
      content: result.likelyNextSteps,
      generated: true,
      editable: false,
    },
  ]
}

export function summarizePreviousSections(sections: VaultSection[]): string | null {
  const summaryBlocks = sections
    .filter((section) => ['summary', 'changes', 'narrative', 'brief'].includes(section.kind))
    .slice(0, 4)
    .map((section) => `${section.title}: ${section.content}`)

  return summaryBlocks.length > 0 ? summaryBlocks.join('\n') : null
}

export function buildDecisionThreadFacts(thread: DecisionThreadRecord): string[] {
  return [
    `Decision thread "${thread.title}" is currently ${thread.status}.`,
    thread.relatedEntityIds.length > 0
      ? `It currently references ${thread.relatedEntityIds.length} linked entities.`
      : 'It currently has no linked entities.',
  ]
}
