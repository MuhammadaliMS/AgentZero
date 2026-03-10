import { buildAssociativeContext } from '@/lib/graph/associative-recall'
import { createUntypedAdminClient } from '@/lib/supabase/admin'
import type { ContextPack, EvidenceItem } from '@/lib/evidence/types'

type AdminClient = ReturnType<typeof createUntypedAdminClient>

/**
 * Build an evidence-first context pack for the agentic pipeline.
 * This expands the existing associative recall with temporal claims,
 * work objects, and generated vault documents.
 */
export async function buildEvidenceContextPack(input: {
  orgId: string
  searchText: string
  artifactId?: string | null
  limit?: number
}): Promise<ContextPack> {
  const supabase = createUntypedAdminClient()
  const limit = input.limit ?? 12
  const associative = await buildAssociativeContext(input.orgId, input.searchText)
  const matchedEntityIds = associative?.matchedEntityIds ?? []

  const matchedEntities = matchedEntityIds.length > 0
    ? await fetchMatchedEntities(supabase, input.orgId, matchedEntityIds)
    : []

  const [activeClaims, decisionThreads, vaultDocuments, recentArtifacts, rawMemories, rawNarratives, rawCommitments] = await Promise.all([
    fetchActiveClaims(supabase, input.orgId, matchedEntityIds, input.artifactId, limit),
    fetchDecisionThreads(supabase, input.orgId, matchedEntityIds, limit),
    fetchVaultDocuments(supabase, input.orgId, matchedEntityIds, limit),
    fetchRecentArtifacts(supabase, input.orgId, matchedEntities.map(entity => entity.name), limit),
    fetchMemories(supabase, input.orgId, matchedEntities.map(entity => entity.name), limit),
    fetchNarratives(supabase, input.orgId, matchedEntities.map(entity => entity.name), limit),
    fetchCommitments(supabase, input.orgId, matchedEntities.map(entity => entity.name), limit),
  ])

  const linkedEvidenceIds = new Set<string>()
  for (const claim of activeClaims) {
    const { data: links } = await supabase
      .from('claim_evidence_links')
      .select('evidence_item_id')
      .eq('org_id', input.orgId)
      .eq('claim_id', claim.id)
      .limit(10)

    for (const link of links ?? []) {
      if (typeof link.evidence_item_id === 'string') {
        linkedEvidenceIds.add(link.evidence_item_id)
      }
    }
  }

  const evidenceItems = linkedEvidenceIds.size > 0
    ? await fetchEvidenceItemsByIds(supabase, input.orgId, [...linkedEvidenceIds])
    : []

  return {
    matchedEntityIds,
    matchedEntities,
    activeClaims,
    evidenceItems,
    commitments: rawCommitments,
    decisionThreads,
    narratives: rawNarratives,
    memories: rawMemories,
    vaultDocuments,
    recentArtifacts,
    contextBlock: associative?.contextBlock ?? null,
  }
}

/**
 * Flatten the context pack into a prompt-friendly markdown block.
 */
export function serializeContextPack(contextPack: ContextPack): string {
  const lines: string[] = []

  if (contextPack.contextBlock) {
    lines.push('## Associative Recall')
    lines.push(contextPack.contextBlock)
    lines.push('')
  }

  if (contextPack.matchedEntities.length > 0) {
    lines.push('## Matched Entities')
    for (const entity of contextPack.matchedEntities) {
      lines.push(`- ${entity.id}: ${entity.name} [${entity.entityType}]${entity.description ? ` — ${entity.description}` : ''}`)
    }
    lines.push('')
  }

  if (contextPack.activeClaims.length > 0) {
    lines.push('## Active Claims')
    for (const claim of contextPack.activeClaims.slice(0, 25)) {
      lines.push(`- ${claim.id}: ${claim.predicate}${claim.objectValue ? ` -> ${claim.objectValue}` : ''} (${claim.claimKind}, ${claim.status})`)
    }
    lines.push('')
  }

  if (contextPack.commitments.length > 0) {
    lines.push('## Commitments')
    for (const commitment of contextPack.commitments.slice(0, 12)) {
      lines.push(`- ${stringValue(commitment.title)} [${stringValue(commitment.status, 'open')}]`)
    }
    lines.push('')
  }

  if (contextPack.decisionThreads.length > 0) {
    lines.push('## Decision Threads')
    for (const thread of contextPack.decisionThreads.slice(0, 12)) {
      lines.push(`- ${thread.title} [${thread.status}]`)
    }
    lines.push('')
  }

  if (contextPack.memories.length > 0) {
    lines.push('## Memories')
    for (const memory of contextPack.memories.slice(0, 10)) {
      lines.push(`- ${stringValue(memory.subject)}: ${stringValue(memory.content).slice(0, 220)}`)
    }
    lines.push('')
  }

  if (contextPack.recentArtifacts.length > 0) {
    lines.push('## Recent Artifacts')
    for (const artifact of contextPack.recentArtifacts.slice(0, 10)) {
      lines.push(`- ${stringValue(artifact.title)} [${stringValue(artifact.channel)}]`)
    }
    lines.push('')
  }

  if (contextPack.vaultDocuments.length > 0) {
    lines.push('## Vault Documents')
    for (const doc of contextPack.vaultDocuments.slice(0, 10)) {
      lines.push(`- ${doc.path}`)
    }
  }

  return lines.join('\n').trim()
}

async function fetchMatchedEntities(
  supabase: AdminClient,
  orgId: string,
  entityIds: string[]
): Promise<ContextPack['matchedEntities']> {
  const { data } = await supabase
    .from('entities')
    .select('id, name, entity_type, description')
    .eq('org_id', orgId)
    .in('id', entityIds)

  return (data ?? []).map((row: Record<string, unknown>) => ({
    id: stringValue(row.id),
    name: stringValue(row.name),
    entityType: stringValue(row.entity_type),
    description: nullableString(row.description),
  }))
}

async function fetchActiveClaims(
  supabase: AdminClient,
  orgId: string,
  entityIds: string[],
  artifactId: string | null | undefined,
  limit: number
): Promise<ContextPack['activeClaims']> {
  if (entityIds.length === 0 && !artifactId) return []

  let query = supabase
    .from('claims')
    .select('*')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .is('valid_to', null)
    .order('updated_at', { ascending: false })
    .limit(limit * 2)

  if (entityIds.length > 0) {
    query = query.or([
      `subject_entity_id.in.(${entityIds.join(',')})`,
      `object_entity_id.in.(${entityIds.join(',')})`,
      artifactId ? `artifact_id.eq.${artifactId}` : null,
    ].filter(Boolean).join(','))
  } else if (artifactId) {
    query = query.eq('artifact_id', artifactId)
  }

  const { data } = await query
  return ((data ?? []) as ContextPack['activeClaims']).slice(0, limit)
}

async function fetchDecisionThreads(
  supabase: AdminClient,
  orgId: string,
  entityIds: string[],
  limit: number
): Promise<ContextPack['decisionThreads']> {
  if (entityIds.length === 0) return []

  const { data } = await supabase
    .from('decision_threads')
    .select('*')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(limit * 2)

  return ((data ?? []) as ContextPack['decisionThreads']).filter(thread => {
    const related = Array.isArray(thread.relatedEntityIds)
      ? thread.relatedEntityIds
      : Array.isArray((thread as unknown as Record<string, unknown>).related_entity_ids)
        ? (thread as unknown as Record<string, unknown>).related_entity_ids as string[]
        : []
    return related.some(id => entityIds.includes(id))
  }).slice(0, limit)
}

async function fetchVaultDocuments(
  supabase: AdminClient,
  orgId: string,
  entityIds: string[],
  limit: number
): Promise<ContextPack['vaultDocuments']> {
  if (entityIds.length === 0) return []

  const { data: links } = await supabase
    .from('vault_document_links')
    .select('vault_document_id')
    .eq('org_id', orgId)
    .eq('link_kind', 'entity')
    .in('target_id', entityIds)
    .limit(limit * 3)

  const docIds = [...new Set((links ?? []).map((link: Record<string, unknown>) => stringValue(link.vault_document_id)).filter(Boolean))]
  if (docIds.length === 0) return []

  const { data } = await supabase
    .from('vault_documents')
    .select('*')
    .eq('org_id', orgId)
    .in('id', docIds)
    .order('updated_at', { ascending: false })
    .limit(limit)

  return (data ?? []) as ContextPack['vaultDocuments']
}

async function fetchRecentArtifacts(
  supabase: AdminClient,
  orgId: string,
  entityNames: string[],
  limit: number
): Promise<ContextPack['recentArtifacts']> {
  const { data } = await supabase
    .from('source_artifacts')
    .select('*')
    .eq('org_id', orgId)
    .order('started_at', { ascending: false })
    .limit(limit * 3)

  if (!data) return []
  if (entityNames.length === 0) return data.slice(0, limit)

  const filtered = (data as Array<Record<string, unknown>>).filter(artifact => {
    const haystack = JSON.stringify(artifact).toLowerCase()
    return entityNames.some(name => haystack.includes(name.toLowerCase()))
  })

  return filtered.slice(0, limit)
}

async function fetchMemories(
  supabase: AdminClient,
  orgId: string,
  entityNames: string[],
  limit: number
): Promise<ContextPack['memories']> {
  const { data } = await supabase
    .from('memory')
    .select('id, subject, content, category, related_entities, metadata, confidence, event_date')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(limit * 4)

  if (!data) return []
  if (entityNames.length === 0) return data.slice(0, limit)

  return (data as Array<Record<string, unknown>>).filter(memory => {
    const relatedEntities = Array.isArray(memory.related_entities)
      ? memory.related_entities.map(value => String(value).toLowerCase())
      : []
    return entityNames.some(name => relatedEntities.includes(name.toLowerCase()))
  }).slice(0, limit)
}

async function fetchNarratives(
  supabase: AdminClient,
  orgId: string,
  entityNames: string[],
  limit: number
): Promise<ContextPack['narratives']> {
  const { data } = await supabase
    .from('strategic_narratives')
    .select('*')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(limit * 3)

  if (!data) return []
  if (entityNames.length === 0) return data.slice(0, limit)

  return (data as Array<Record<string, unknown>>).filter(narrative => {
    const haystack = JSON.stringify(narrative).toLowerCase()
    return entityNames.some(name => haystack.includes(name.toLowerCase()))
  }).slice(0, limit)
}

async function fetchCommitments(
  supabase: AdminClient,
  orgId: string,
  entityNames: string[],
  limit: number
): Promise<ContextPack['commitments']> {
  const { data } = await supabase
    .from('commitments')
    .select('*')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(limit * 4)

  if (!data) return []
  if (entityNames.length === 0) return data.slice(0, limit)

  return (data as Array<Record<string, unknown>>).filter(commitment => {
    const haystack = `${stringValue(commitment.title)} ${stringValue(commitment.description)} ${JSON.stringify(commitment.metadata ?? {})}`.toLowerCase()
    return entityNames.some(name => haystack.includes(name.toLowerCase()))
  }).slice(0, limit)
}

async function fetchEvidenceItemsByIds(
  supabase: AdminClient,
  orgId: string,
  evidenceItemIds: string[]
): Promise<EvidenceItem[]> {
  if (evidenceItemIds.length === 0) return []

  const { data } = await supabase
    .from('evidence_items')
    .select('*')
    .eq('org_id', orgId)
    .in('id', evidenceItemIds)
    .order('happened_at', { ascending: true })

  return ((data ?? []) as Array<Record<string, unknown>>).map(item => ({
    id: stringValue(item.id),
    artifactId: stringValue(item.artifact_id),
    orgId: stringValue(item.org_id),
    sequenceNo: Number(item.sequence_no ?? 0),
    authorName: nullableString(item.author_name),
    authorEntityId: nullableString(item.author_entity_id),
    happenedAt: nullableString(item.happened_at),
    text: stringValue(item.text),
    sourceAnchor: stringValue(item.source_anchor),
    metadata: (item.metadata as Record<string, unknown>) ?? {},
  }))
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
