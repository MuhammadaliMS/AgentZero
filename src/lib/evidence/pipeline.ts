import { mutationBundleSchema } from '@/lib/evidence/schema'
import { runChannelAnalyst, runStateSynthesizer } from '@/lib/evidence/agents'
import { buildEvidenceContextPack } from '@/lib/evidence/context-pack'
import {
  applyMutationBundle,
  regenerateVaultDocuments,
  upsertEvidenceItems,
  upsertSourceArtifact,
} from '@/lib/evidence/store'
import {
  normalizeChatArtifact,
  normalizeEmailArtifact,
  normalizeMeetingArtifact,
  normalizeSlackArtifact,
  type NormalizedArtifact,
  type NormalizedEvidenceItem,
} from '@/lib/evidence/normalizers'
import { selectEvidenceForPrompt } from '@/lib/evidence/selection'
import type { EvidencePipelineParams, EvidencePipelineResult } from '@/lib/evidence/types'
import { createUntypedAdminClient } from '@/lib/supabase/admin'

type AdminClient = ReturnType<typeof createUntypedAdminClient>

/**
 * Evidence-first pipeline entrypoint.
 * Canonical flow: normalize -> persist source/evidence -> build context ->
 * analyst -> synthesizer -> apply bundle -> regenerate vault.
 */
export async function runEvidencePipeline(params: EvidencePipelineParams): Promise<EvidencePipelineResult> {
  const supabase = createUntypedAdminClient()
  const normalized = normalizeSource(params)
  const artifact = await upsertSourceArtifact(supabase, normalized.artifact)
  const persistedEvidenceItems = await upsertEvidenceItems(supabase, {
    orgId: params.orgId,
    artifactId: artifact.id,
    evidenceItems: normalized.evidenceItems,
    artifact: normalized.artifact,
    sourceSummary: normalized.sourceSummary,
  })

  const searchText = buildEvidenceSearchText({
    artifactTitle: artifact.title,
    evidenceItems: persistedEvidenceItems,
    sourceSummary: normalized.sourceSummary,
  })

  const contextPack = await buildEvidenceContextPack({
    orgId: params.orgId,
    searchText,
    artifactId: artifact.id,
  })

  const analystBundle = await runChannelAnalyst({
    artifact,
    evidenceItems: persistedEvidenceItems,
    contextPack,
    sourceSummary: normalized.sourceSummary,
  })

  if (!analystBundle) {
    console.warn(`[evidence-pipeline] Channel analyst returned null for "${artifact.title}" — structured output will be empty`)
  } else {
    console.log(
      `[evidence-pipeline] Channel analyst produced:`,
      `${analystBundle.entities.length} entities, ${analystBundle.claims.length} claims,`,
      `${analystBundle.memories.length} memories`
    )
  }

  const finalBundle = analystBundle
    ? await runStateSynthesizer({
      artifact,
      evidenceItems: persistedEvidenceItems,
      contextPack,
      analystBundle,
      sourceSummary: normalized.sourceSummary,
    }) ?? analystBundle
    : null

  const parsedBundle = finalBundle
    ? mutationBundleSchema.parse(finalBundle)
    : mutationBundleSchema.parse({
      version: 1,
      source: 'state_synthesizer',
      entities: [],
      claims: [],
      commitments: [],
      decisionThreads: [],
      memories: [],
      vaultDocuments: [],
    })

  if (!finalBundle) {
    console.warn(`[evidence-pipeline] Using empty fallback bundle for "${artifact.title}" — no claims/memories will be created`)
  }

  const applied = await applyMutationBundle(supabase, {
    orgId: params.orgId,
    artifactId: artifact.id,
    bundle: parsedBundle,
    persistedEvidenceItems,
    contextPack,
  })

  if (params.source.kind === 'meeting') {
    await linkMeetingCanonicalRecords(supabase, {
      orgId: params.orgId,
      meetingId: String(params.source.meeting.id),
      artifactId: artifact.id,
      evidenceItems: persistedEvidenceItems,
      applied,
    })
  }

  const affectedVaultPaths = await regenerateVaultDocuments(supabase, {
    orgId: params.orgId,
    artifactId: artifact.id,
    applied,
  })

  return {
    artifactId: artifact.id,
    evidenceItemIds: persistedEvidenceItems.map(item => item.id),
    bundle: parsedBundle,
    affectedVaultPaths,
  }
}

export function normalizeSource(params: EvidencePipelineParams): {
  artifact: NormalizedArtifact
  evidenceItems: NormalizedEvidenceItem[]
  sourceSummary: Record<string, unknown> | null
} {
  if (params.source.kind === 'meeting') {
    const normalized = normalizeMeetingArtifact({
      orgId: params.orgId,
      meeting: params.source.meeting as {
        id: string
        title: string
        scheduled_start?: string | null
        actual_end?: string | null
        meeting_url?: string | null
        participants?: Array<{ name?: string; email?: string }> | null
      },
      segments: params.source.segments as Array<{
        id: string
        speaker?: string | null
        text: string
        start_time?: number | null
        end_time?: number | null
        created_at?: string | null
      }>,
    })

    return {
      ...normalized,
      sourceSummary: {
        summary: params.source.summary ?? null,
        actionItems: params.source.actionItems ?? [],
        decisions: params.source.decisions ?? [],
      },
    }
  }

  if (params.source.kind === 'email') {
    const normalized = normalizeEmailArtifact({
      orgId: params.orgId,
      provider: params.source.provider,
      thread: params.source.thread as {
        id: string
        subject: string
        participants?: string[]
        sourceUrl?: string | null
      },
      messages: params.source.messages as Array<{
        id: string
        authorName?: string | null
        authorEmail?: string | null
        text: string
        happenedAt?: string | null
      }>,
    })

    return {
      ...normalized,
      sourceSummary: null,
    }
  }

  if (params.source.kind === 'slack') {
    const normalized = normalizeSlackArtifact({
      orgId: params.orgId,
      conversation: params.source.conversation as {
        channelId: string
        channelName: string
        channelType: 'public' | 'private' | 'dm' | 'group_dm'
        threadTs?: string | null
        sourceUrl?: string | null
      },
      messages: params.source.messages as Array<{
        ts: string
        userName?: string | null
        userEmail?: string | null
        text: string
        happenedAt?: string | null
      }>,
    })

    return {
      ...normalized,
      sourceSummary: null,
    }
  }

  const normalized = normalizeChatArtifact({
    orgId: params.orgId,
    conversation: params.source.conversation as {
      id: string
      title?: string | null
      created_at?: string | null
      updated_at?: string | null
    },
    messages: params.source.messages as Array<{
      id: string
      role: string
      content: string
      created_at?: string | null
    }>,
    toolOutputs: params.source.toolOutputs,
  })

  return {
    ...normalized,
    sourceSummary: null,
  }
}

export async function linkMeetingCanonicalRecords(
  supabase: AdminClient,
  input: {
    orgId: string
    meetingId: string
    artifactId: string
    evidenceItems: Array<{ id: string; metadata: Record<string, unknown>; text: string }>
    applied: {
      commitmentsByTitle: Map<string, string>
      decisionThreadsByTitle: Map<string, string>
    }
  }
): Promise<void> {
  const evidenceByStartTime = input.evidenceItems
    .map(item => ({
      id: item.id,
      startTime: typeof item.metadata.startTime === 'number' ? item.metadata.startTime : null,
      text: item.text,
    }))

  const { data: actionItems } = await supabase
    .from('meeting_action_items')
    .select('id, action, context_timestamp')
    .eq('meeting_id', input.meetingId)

  for (const actionItem of actionItems ?? []) {
    const action = String(actionItem.action ?? '')
    const matchedCommitmentId = matchCanonicalId(action, input.applied.commitmentsByTitle)
    const matchedEvidenceId = matchNearestEvidenceId(actionItem.context_timestamp as number | null, action, evidenceByStartTime)

    await supabase
      .from('meeting_action_items')
      .update({
        source_artifact_id: input.artifactId,
        evidence_item_id: matchedEvidenceId,
        commitment_id: matchedCommitmentId,
      })
      .eq('id', actionItem.id)
  }

  const { data: decisions } = await supabase
    .from('meeting_decisions')
    .select('id, decision, context_timestamp')
    .eq('meeting_id', input.meetingId)

  for (const decision of decisions ?? []) {
    const decisionText = String(decision.decision ?? '')
    const matchedDecisionThreadId = matchCanonicalId(decisionText, input.applied.decisionThreadsByTitle)
    const matchedEvidenceId = matchNearestEvidenceId(decision.context_timestamp as number | null, decisionText, evidenceByStartTime)

    await supabase
      .from('meeting_decisions')
      .update({
        source_artifact_id: input.artifactId,
        evidence_item_id: matchedEvidenceId,
        decision_thread_id: matchedDecisionThreadId,
      })
      .eq('id', decision.id)
  }
}

export function buildEvidenceSearchText(input: {
  artifactTitle: string
  evidenceItems: Array<{ text: string; id?: string; sequenceNo?: number; sourceAnchor?: string; metadata?: Record<string, unknown>; authorName?: string | null; happenedAt?: string | null }>
  sourceSummary?: Record<string, unknown> | null
}): string {
  return [
    input.artifactTitle,
    ...selectEvidenceForPrompt({
      artifactTitle: input.artifactTitle,
      evidenceItems: input.evidenceItems.map((item, index) => ({
        id: item.id ?? `evidence-${index}`,
        sequenceNo: item.sequenceNo ?? index + 1,
        sourceAnchor: item.sourceAnchor ?? `synthetic:${index + 1}`,
        metadata: item.metadata ?? {},
        authorName: item.authorName ?? null,
        happenedAt: item.happenedAt ?? null,
        text: item.text,
      })),
      sourceSummary: input.sourceSummary,
      maxItems: 24,
    }).map(item => item.text),
  ].join('\n').slice(0, 12_000)
}

function matchCanonicalId(text: string, candidates: Map<string, string>): string | null {
  const normalized = text.toLowerCase().trim()
  for (const [candidate, id] of candidates.entries()) {
    if (normalized.includes(candidate) || candidate.includes(normalized)) {
      return id
    }
  }
  return null
}

function matchNearestEvidenceId(
  contextTimestamp: number | null,
  text: string,
  evidenceItems: Array<{ id: string; startTime: number | null; text: string }>
): string | null {
  if (contextTimestamp != null) {
    const exact = evidenceItems
      .filter(item => item.startTime != null)
      .sort((left, right) => Math.abs((left.startTime ?? 0) - contextTimestamp) - Math.abs((right.startTime ?? 0) - contextTimestamp))[0]
    if (exact?.id) return exact.id
  }

  const normalized = text.toLowerCase()
  const fuzzy = evidenceItems.find(item => item.text.toLowerCase().includes(normalized.slice(0, 30)))
  return fuzzy?.id ?? null
}
