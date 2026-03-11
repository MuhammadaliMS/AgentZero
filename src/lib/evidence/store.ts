import type { Json } from '@/types/database'
import { createUntypedAdminClient } from '@/lib/supabase/admin'
import { generateEmbedding, type ExtractedEntity } from '@/lib/openai/client'
import { normalizeCanonical, upsertEntities, upsertRelationship } from '@/lib/graph/extraction-pipeline'
import { buildClaimKey, type NormalizedArtifact, type NormalizedEvidenceItem } from '@/lib/evidence/normalizers'
import type { ContextPack, EvidenceItem, SourceArtifact } from '@/lib/evidence/types'
import type { MutationBundle } from '@/lib/evidence/schema'
import { selectEvidenceForEmbedding } from '@/lib/evidence/selection'
import {
  buildEntityVaultPath,
  buildTimelineVaultPath,
  renderCommitmentDocument,
  renderDecisionThreadDocument,
  renderEntityDocument,
  renderNarrativeDocument,
  renderSourceArtifactDocument,
  renderTimelineDocument,
  slugifyVaultSegment,
  type RenderedVaultDocument,
} from '@/lib/evidence/vault'

type AdminClient = ReturnType<typeof createUntypedAdminClient>
const EVIDENCE_EMBEDDING_BATCH_SIZE = Math.max(Number(process.env.EVIDENCE_EMBEDDING_BATCH_SIZE) || 25, 1)
const VALID_MEMORY_CATEGORIES = new Set([
  'decision',
  'context',
  'preference',
  'relationship',
  'fact',
  'task',
  'meeting_outcome',
  'project_status',
  'blocker',
  'deadline',
  'pattern',
  'strategic_insight',
])

export interface AppliedMutationResult {
  artifactId: string
  evidenceItemIds: string[]
  claimIds: string[]
  entityIds: string[]
  decisionThreadIds: string[]
  commitmentIds: string[]
  memoryIds: string[]
  affectedVaultPaths: string[]
  entitiesByRef: Map<string, string>
  commitmentsByTitle: Map<string, string>
  decisionThreadsByTitle: Map<string, string>
}

/**
 * Upsert a canonical source artifact.
 */
export async function upsertSourceArtifact(
  supabase: AdminClient,
  artifact: NormalizedArtifact
): Promise<SourceArtifact> {
  const { data, error } = await supabase
    .from('source_artifacts')
    .upsert({
      org_id: artifact.orgId,
      channel: artifact.channel,
      external_id: artifact.externalId,
      title: artifact.title,
      source_url: artifact.sourceUrl,
      started_at: artifact.startedAt,
      ended_at: artifact.endedAt,
      raw_ref: artifact.rawRef,
      metadata: artifact.metadata as Json,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,channel,external_id' })
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(`Failed to upsert source artifact: ${error?.message ?? 'unknown error'}`)
  }

  return mapSourceArtifact(data)
}

/**
 * Upsert evidence items for a source artifact and return their persisted rows.
 */
export async function upsertEvidenceItems(
  supabase: AdminClient,
  input: {
    orgId: string
    artifactId: string
    evidenceItems: NormalizedEvidenceItem[]
    artifact?: NormalizedArtifact | null
    sourceSummary?: Record<string, unknown> | null
  }
): Promise<EvidenceItem[]> {
  if (input.evidenceItems.length === 0) return []

  const selectedForEmbedding = new Set(
    selectEvidenceItemsForEmbedding(input.evidenceItems, {
      artifactTitle: input.artifact?.title,
      sourceSummary: input.sourceSummary,
    }).map(item => item.sourceAnchor)
  )

  const rows: Array<Record<string, unknown>> = []
  for (const batch of splitIntoChunks(input.evidenceItems, EVIDENCE_EMBEDDING_BATCH_SIZE)) {
    const batchRows = await Promise.all(batch.map(async item => {
      const shouldEmbed = selectedForEmbedding.has(item.sourceAnchor)
      const embedding = shouldEmbed
        ? await generateEmbedding(item.text.slice(0, 4000))
        : null
      return {
        org_id: input.orgId,
        artifact_id: input.artifactId,
        sequence_no: item.sequenceNo,
        author_name: item.authorName,
        happened_at: item.happenedAt,
        text: item.text,
        source_anchor: item.sourceAnchor,
        embedding: embedding ? JSON.stringify(embedding) : null,
        metadata: item.metadata as Json,
        updated_at: new Date().toISOString(),
      }
    }))
    rows.push(...batchRows)
  }

  const { data, error } = await supabase
    .from('evidence_items')
    .upsert(rows, { onConflict: 'artifact_id,source_anchor' })
    .select('*')

  if (error) {
    throw new Error(`Failed to upsert evidence items: ${error.message}`)
  }

  return (data ?? []).map(mapEvidenceItem)
}

export function selectEvidenceItemsForEmbedding(
  evidenceItems: NormalizedEvidenceItem[],
  options?: {
    artifactTitle?: string
    sourceSummary?: Record<string, unknown> | null
  }
): NormalizedEvidenceItem[] {
  return selectEvidenceForEmbedding(evidenceItems, options)
}

/**
 * Apply a validated mutation bundle to the canonical evidence graph.
 */
export async function applyMutationBundle(
  supabase: AdminClient,
  input: {
    orgId: string
    artifactId: string
    bundle: MutationBundle
    persistedEvidenceItems: EvidenceItem[]
    contextPack: ContextPack
  }
): Promise<AppliedMutationResult> {
  const result: AppliedMutationResult = {
    artifactId: input.artifactId,
    evidenceItemIds: input.persistedEvidenceItems.map(item => item.id),
    claimIds: [],
    entityIds: [...input.contextPack.matchedEntityIds],
    decisionThreadIds: [],
    commitmentIds: [],
    memoryIds: [],
    affectedVaultPaths: [],
    entitiesByRef: new Map(),
    commitmentsByTitle: new Map(),
    decisionThreadsByTitle: new Map(),
  }

  const evidenceById = new Map(input.persistedEvidenceItems.map(item => [item.id, item]))
  const contextEntityNames = new Map(input.contextPack.matchedEntities.map(entity => [normalizeRef(entity.name), entity.id]))

  for (const entity of input.contextPack.matchedEntities) {
    const canonical = normalizeRef(entity.name)
    result.entitiesByRef.set(entity.id, entity.id)
    result.entitiesByRef.set(canonical, entity.id)
    result.entitiesByRef.set(`entity:${canonical}`, entity.id)
    result.entitiesByRef.set(`entity_id:${entity.id}`, entity.id)
  }

  if (input.bundle.entities.length > 0) {
    const extractedEntities: ExtractedEntity[] = input.bundle.entities.map(entity => ({
      name: entity.name,
      type: entity.entityType as ExtractedEntity['type'],
      description: entity.description ?? undefined,
      attributes: entity.attributes ?? {},
    }))

    const upsertedMap = await upsertEntities(supabase as never, input.orgId, extractedEntities)
    for (const entity of input.bundle.entities) {
      const entityId = upsertedMap.get(entity.canonicalName ? normalizeCanonical(entity.canonicalName) : normalizeCanonical(entity.name))
      if (!entityId) continue
      result.entityIds.push(entityId)
      const canonical = normalizeRef(entity.canonicalName || entity.name)
      result.entitiesByRef.set(canonical, entityId)
      result.entitiesByRef.set(entity.name, entityId)
      result.entitiesByRef.set(`entity:${canonical}`, entityId)
      result.entitiesByRef.set(`entity_id:${entityId}`, entityId)
    }
  }

  if (input.bundle.evidenceItems.length > 0) {
    const syntheticEvidence = input.bundle.evidenceItems.map(item => ({
      sequenceNo: item.sequenceNo,
      authorName: item.authorName ?? null,
      happenedAt: item.happenedAt ?? null,
      text: item.text,
      sourceAnchor: item.sourceAnchor,
      artifactChannel: item.artifactChannel,
      metadata: item.metadata,
    }))
    const persistedSyntheticEvidence = await upsertEvidenceItems(supabase, {
      orgId: input.orgId,
      artifactId: input.artifactId,
      evidenceItems: syntheticEvidence,
      sourceSummary: null,
    })
    for (const item of persistedSyntheticEvidence) {
      evidenceById.set(item.id, item)
      result.evidenceItemIds.push(item.id)
    }
  }

  for (const claim of input.bundle.claims) {
    const subjectEntityId = await resolveEntityRef(supabase, input.orgId, claim.subjectEntityRef, result.entitiesByRef, contextEntityNames)
    const objectEntityId = claim.objectEntityRef
      ? await resolveEntityRef(supabase, input.orgId, claim.objectEntityRef, result.entitiesByRef, contextEntityNames)
      : null

    if (!subjectEntityId) continue

    const claimKey = buildClaimKey({
      orgId: input.orgId,
      claimKind: claim.claimKind,
      subjectEntityId,
      predicate: claim.predicate,
      objectEntityId,
      objectValue: claim.objectValue ?? null,
      artifactId: input.artifactId,
    })

    await supersedeConflictingClaims(supabase, {
      orgId: input.orgId,
      artifactId: input.artifactId,
      claimKind: claim.claimKind,
      subjectEntityId,
      predicate: claim.predicate,
      claimKey,
      objectEntityId,
      objectValue: claim.objectValue ?? null,
      validFrom: claim.validFrom ?? null,
    })

    const { data: persistedClaim, error } = await supabase
      .from('claims')
      .upsert({
        org_id: input.orgId,
        artifact_id: input.artifactId,
        claim_key: claimKey,
        claim_kind: claim.claimKind,
        subject_entity_id: subjectEntityId,
        predicate: claim.predicate,
        object_entity_id: objectEntityId,
        object_value: claim.objectValue ?? null,
        confidence: claim.confidence,
        evidence_status: claim.evidenceStatus,
        status: 'active',
        valid_from: claim.validFrom ?? new Date().toISOString(),
        valid_to: claim.validTo ?? null,
        metadata: claim.metadata as Json,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'org_id,claim_key' })
      .select('id, claim_kind, subject_entity_id, object_entity_id, predicate, object_value')
      .single()

    if (error || !persistedClaim) {
      console.error('[evidence-store] Failed to upsert claim:', error?.message)
      continue
    }

    result.claimIds.push(persistedClaim.id)

    for (const evidenceRef of claim.evidenceItemRefs) {
      const evidenceId = resolveEvidenceRef(evidenceRef, evidenceById)
      if (!evidenceId) continue

      await supabase
        .from('claim_evidence_links')
        .upsert({
          org_id: input.orgId,
          claim_id: persistedClaim.id,
          evidence_item_id: evidenceId,
          link_type: 'support',
        }, { onConflict: 'claim_id,evidence_item_id,link_type' })
    }

    if (claim.claimKind === 'relationship' && objectEntityId) {
      await upsertRelationship(
        supabase as never,
        input.orgId,
        null,
        subjectEntityId,
        objectEntityId,
        {
          source: claim.subjectEntityRef,
          target: claim.objectEntityRef ?? '',
          type: claim.predicate,
          properties: claim.metadata ?? {},
          confidence: claim.confidence,
        }
      )
    }
  }

  const claimsByPredicate = await fetchClaimsByIds(supabase, input.orgId, result.claimIds)

  for (const thread of input.bundle.decisionThreads) {
    const title = stringFromUnknown(thread.title)
    if (!title) continue
    const relatedEntityIds = await resolveEntityRefs(
      supabase,
      input.orgId,
      arrayOfStrings(thread.relatedEntityRefs),
      result.entitiesByRef,
      contextEntityNames
    )
    const dedupeKey = `${slugifyVaultSegment(title)}|${[...new Set(relatedEntityIds)].sort().join('|')}`
    const currentClaimId = pickCurrentClaimId(claimsByPredicate, stringFromUnknown(thread.currentClaimRef), 'decision', title)

    const { data } = await supabase
      .from('decision_threads')
      .upsert({
        org_id: input.orgId,
        title,
        canonical_title: normalizeCanonical(title),
        dedupe_key: dedupeKey,
        status: stringFromUnknown(thread.status, 'open'),
        current_claim_id: currentClaimId,
        first_artifact_id: input.artifactId,
        last_artifact_id: input.artifactId,
        related_entity_ids: relatedEntityIds,
        metadata: (thread.metadata as Json) ?? {},
        updated_at: new Date().toISOString(),
      }, { onConflict: 'org_id,dedupe_key' })
      .select('id, title')
      .single()

    if (data?.id) {
      result.decisionThreadIds.push(data.id)
      result.decisionThreadsByTitle.set(normalizeRef(title), data.id)
    }
  }

  for (const commitment of input.bundle.commitments) {
    const title = stringFromUnknown(commitment.title)
    if (!title) continue

    const ownerEntityId = stringFromUnknown(commitment.ownerEntityRef)
      ? await resolveEntityRef(supabase, input.orgId, stringFromUnknown(commitment.ownerEntityRef), result.entitiesByRef, contextEntityNames)
      : null
    const relatedEntityIds = await resolveEntityRefs(
      supabase,
      input.orgId,
      arrayOfStrings(commitment.relatedEntityRefs),
      result.entitiesByRef,
      contextEntityNames
    )
    const evidenceId = resolveEvidenceRef(arrayOfStrings(commitment.evidenceItemRefs)[0] ?? null, evidenceById)
    const decisionThreadTitle = stringFromUnknown(commitment.decisionThreadTitle)
    const decisionThreadId = decisionThreadTitle
      ? result.decisionThreadsByTitle.get(normalizeRef(decisionThreadTitle)) ?? null
      : null
    const sourceClaimId = pickCurrentClaimId(claimsByPredicate, title, 'commitment', title)
    const existing = await findExistingCommitment(supabase, input.orgId, title)

    const commitmentMetadata = {
      ...(objectValue(commitment.metadata) ?? {}),
      owner_entity_id: ownerEntityId,
      related_entity_ids: relatedEntityIds,
      source_artifact_id: input.artifactId,
    }

    const row = {
      org_id: input.orgId,
      title,
      description: stringFromUnknown(commitment.description) || null,
      status: stringFromUnknown(commitment.status, stringFromUnknown(existing?.status, 'open')),
      priority: stringFromUnknown(commitment.priority, stringFromUnknown(existing?.priority, 'P2')),
      due_date: stringFromUnknown(commitment.dueDate) || null,
      source: 'evidence_graph_v2',
      source_ref: input.artifactId,
      owner_entity_id: ownerEntityId,
      related_entity_ids: relatedEntityIds,
      metadata: commitmentMetadata as Json,
      source_claim_id: sourceClaimId,
      latest_evidence_item_id: evidenceId,
      decision_thread_id: decisionThreadId,
      updated_at: new Date().toISOString(),
    }

    const { data } = existing
      ? await supabase
        .from('commitments')
        .update(row)
        .eq('id', existing.id)
        .select('*')
        .single()
      : await supabase
        .from('commitments')
        .insert(row)
        .select('*')
        .single()

    if (data?.id) {
      result.commitmentIds.push(data.id)
      result.commitmentsByTitle.set(normalizeRef(title), data.id)
    }
  }

  for (const memory of input.bundle.memories) {
    const subject = stringFromUnknown(memory.subject)
    if (!subject) continue

    const relatedEntityNames = arrayOfStrings(memory.relatedEntities)
    const relatedEntityIds = await resolveEntityRefs(
      supabase,
      input.orgId,
      relatedEntityNames,
      result.entitiesByRef,
      contextEntityNames
    )

    const { data: existing } = await supabase
      .from('memory')
      .select('id')
      .eq('org_id', input.orgId)
      .eq('subject', subject)
      .maybeSingle()

    const primaryClaimIds = pickClaimIdsByPredicates(claimsByPredicate, arrayOfStrings(memory.primaryClaimPredicates))
    const memoryMetadata = {
      ...(objectValue(memory.metadata) ?? {}),
      source_artifact_ids: [input.artifactId],
      primary_claim_ids: primaryClaimIds,
      citation_coverage: result.evidenceItemIds.length > 0 ? 1 : 0,
    }

    const payload = {
      org_id: input.orgId,
      subject,
      content: stringFromUnknown(memory.content),
      category: sanitizeMemoryCategory(stringFromUnknown(memory.category, 'context')),
      confidence: numericValue(memory.confidence, 0.8),
      related_entities: relatedEntityNames,
      source: 'evidence_graph_v2',
      source_artifact_ids: [input.artifactId],
      primary_claim_ids: primaryClaimIds,
      citation_coverage: result.evidenceItemIds.length > 0 ? 1 : 0,
      metadata: memoryMetadata as Json,
      updated_at: new Date().toISOString(),
    }

    const { data } = existing
      ? await supabase.from('memory').update(payload).eq('id', existing.id).select('id').single()
      : await supabase.from('memory').insert(payload).select('id').single()

    const memoryId = data?.id
    if (memoryId) {
      result.memoryIds.push(memoryId)
      if (relatedEntityIds.length > 0) {
        for (const entityId of relatedEntityIds) {
          await supabase
            .from('memory_entity_links')
            .upsert({
              memory_id: memoryId,
              entity_id: entityId,
            }, { onConflict: 'memory_id,entity_id' })
        }
      }
    }
  }

  return result
}

/**
 * Regenerate generated vault documents touched by the latest bundle application.
 */
export async function regenerateVaultDocuments(
  supabase: AdminClient,
  input: {
    orgId: string
    artifactId: string
    applied: AppliedMutationResult
  }
): Promise<string[]> {
  const affectedPaths: string[] = []

  const artifact = await fetchArtifactById(supabase, input.orgId, input.artifactId)
  const artifactEvidence = await fetchEvidenceForArtifact(supabase, input.orgId, input.artifactId)

  if (artifact) {
    const sourceDoc = renderSourceArtifactDocument({
      artifact,
      evidenceItems: artifactEvidence,
    })
    await upsertVaultDocument(supabase, input.orgId, sourceDoc)
    affectedPaths.push(sourceDoc.path)
  }

  const uniqueEntityIds = [...new Set(input.applied.entityIds.filter(Boolean))]
  for (const entityId of uniqueEntityIds) {
    const entity = await fetchEntityById(supabase, input.orgId, entityId)
    if (!entity) continue
    const claims = await fetchClaimsForEntity(supabase, input.orgId, entityId)
    const commitments = await fetchCommitmentsForEntity(supabase, input.orgId, entityId)
    const decisionThreads = await fetchDecisionThreadsForEntity(supabase, input.orgId, entityId)
    const evidenceItems = await fetchEvidenceForClaims(
      supabase,
      input.orgId,
      claims.map(claim => stringFromUnknown(claim.id)).filter(Boolean)
    )

    const entityDoc = renderEntityDocument({
      entity,
      claims,
      commitments,
      decisionThreads,
      evidenceItems,
    })
    await upsertVaultDocument(supabase, input.orgId, entityDoc)
    affectedPaths.push(entityDoc.path)

    const timelineDoc = renderTimelineDocument({
      title: entity.name,
      claims,
      evidenceItems,
      path: buildTimelineVaultPath(entity.name),
    })
    await upsertVaultDocument(supabase, input.orgId, timelineDoc)
    affectedPaths.push(timelineDoc.path)
  }

  for (const commitmentId of [...new Set(input.applied.commitmentIds)]) {
    const commitment = await fetchCommitmentById(supabase, input.orgId, commitmentId)
    if (!commitment) continue
    const latestEvidenceItemId = stringFromUnknown(commitment.latest_evidence_item_id)
    const evidenceItems = latestEvidenceItemId
      ? await fetchEvidenceItemsByIds(supabase, input.orgId, [latestEvidenceItemId])
      : []
    const commitmentDoc = renderCommitmentDocument({
      commitment,
      evidenceItems,
    })
    await upsertVaultDocument(supabase, input.orgId, commitmentDoc)
    affectedPaths.push(commitmentDoc.path)
  }

  for (const decisionThreadId of [...new Set(input.applied.decisionThreadIds)]) {
    const thread = await fetchDecisionThreadById(supabase, input.orgId, decisionThreadId)
    if (!thread) continue
    const claims = thread.current_claim_id
      ? await fetchClaimsByIds(supabase, input.orgId, [stringFromUnknown(thread.current_claim_id)])
      : []
    const evidenceItems = await fetchEvidenceForClaims(
      supabase,
      input.orgId,
      claims.map(claim => stringFromUnknown(claim.id)).filter(Boolean)
    )
    const threadDoc = renderDecisionThreadDocument({
      decisionThread: thread,
      claims,
      evidenceItems,
    })
    await upsertVaultDocument(supabase, input.orgId, threadDoc)
    affectedPaths.push(threadDoc.path)
  }

  if (input.applied.memoryIds.length > 0) {
    const { data: memories } = await supabase
      .from('memory')
      .select('id, subject, content')
      .eq('org_id', input.orgId)
      .in('id', input.applied.memoryIds)

    for (const memory of memories ?? []) {
      const narrativeDoc = renderNarrativeDocument({
        title: stringFromUnknown(memory.subject),
        content: stringFromUnknown(memory.content),
        linkedIds: [stringFromUnknown(memory.id)],
      })
      await upsertVaultDocument(supabase, input.orgId, narrativeDoc)
      affectedPaths.push(narrativeDoc.path)
    }
  }

  return [...new Set(affectedPaths)]
}

export async function fetchEvidenceItemsByIds(
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

  return (data ?? []).map(mapEvidenceItem)
}

async function upsertVaultDocument(
  supabase: AdminClient,
  orgId: string,
  doc: RenderedVaultDocument
): Promise<void> {
  const { data } = await supabase
    .from('vault_documents')
    .upsert({
      org_id: orgId,
      path: doc.path,
      title: doc.title,
      document_type: doc.documentType,
      content_markdown: doc.contentMarkdown,
      frontmatter: doc.frontmatter as Json,
      source_mode: doc.sourceMode,
      metadata: doc.metadata as Json,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,path' })
    .select('id')
    .single()

  const vaultDocumentId = data?.id
  if (!vaultDocumentId) return

  for (const link of doc.links) {
    await supabase
      .from('vault_document_links')
      .upsert({
        org_id: orgId,
        vault_document_id: vaultDocumentId,
        link_kind: link.linkKind,
        target_id: link.targetId,
      }, { onConflict: 'vault_document_id,link_kind,target_id' })
  }
}

async function resolveEntityRefs(
  supabase: AdminClient,
  orgId: string,
  refs: string[],
  entitiesByRef: Map<string, string>,
  contextEntityNames: Map<string, string>
): Promise<string[]> {
  const resolved = await Promise.all(refs.map(ref => resolveEntityRef(supabase, orgId, ref, entitiesByRef, contextEntityNames)))
  return resolved.filter((id): id is string => Boolean(id))
}

async function resolveEntityRef(
  supabase: AdminClient,
  orgId: string,
  ref: string,
  entitiesByRef: Map<string, string>,
  contextEntityNames: Map<string, string>
): Promise<string | null> {
  const trimmed = ref.trim()
  if (!trimmed) return null

  const direct = entitiesByRef.get(trimmed) || entitiesByRef.get(normalizeRef(trimmed))
  if (direct) return direct

  const contextMatch = contextEntityNames.get(normalizeRef(trimmed))
  if (contextMatch) return contextMatch

  const entityIdPrefix = trimmed.startsWith('entity_id:') ? trimmed.replace('entity_id:', '') : null
  if (entityIdPrefix) return entityIdPrefix

  const canonical = normalizeCanonical(trimmed.replace(/^entity:/, ''))
  const { data } = await supabase
    .from('entities')
    .select('id')
    .eq('org_id', orgId)
    .eq('canonical_name', canonical)
    .maybeSingle()

  if (data?.id) {
    entitiesByRef.set(trimmed, data.id)
    entitiesByRef.set(normalizeRef(trimmed), data.id)
    return data.id
  }

  const { data: aliasMatches } = await supabase
    .from('entity_aliases')
    .select('entity_id')
    .eq('org_id', orgId)
    .eq('normalized_alias', canonical)
    .limit(2)

  if ((aliasMatches ?? []).length === 1 && typeof aliasMatches?.[0]?.entity_id === 'string') {
    const entityId = aliasMatches[0].entity_id
    entitiesByRef.set(trimmed, entityId)
    entitiesByRef.set(normalizeRef(trimmed), entityId)
    return entityId
  }

  return null
}

function resolveEvidenceRef(ref: string | null, evidenceById: Map<string, EvidenceItem>): string | null {
  if (!ref) return null
  if (evidenceById.has(ref)) return ref

  const byAnchor = [...evidenceById.values()].find(item => item.sourceAnchor === ref)
  return byAnchor?.id ?? null
}

async function supersedeConflictingClaims(
  supabase: AdminClient,
  input: {
    orgId: string
    artifactId: string
    claimKind: string
    subjectEntityId: string
    predicate: string
    claimKey: string
    objectEntityId: string | null
    objectValue: string | null
    validFrom: string | null
  }
): Promise<void> {
  const { data: existingClaims } = await supabase
    .from('claims')
    .select('id, claim_key, object_entity_id, object_value')
    .eq('org_id', input.orgId)
    .eq('claim_kind', input.claimKind)
    .eq('subject_entity_id', input.subjectEntityId)
    .eq('predicate', input.predicate)
    .eq('status', 'active')
    .is('valid_to', null)

  for (const existing of existingClaims ?? []) {
    if (existing.claim_key === input.claimKey) continue
    const sameObject = existing.object_entity_id === input.objectEntityId && stringFromUnknown(existing.object_value) === (input.objectValue ?? '')
    if (sameObject) continue

    await supabase
      .from('claims')
      .update({
        status: 'superseded',
        valid_to: input.validFrom ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
  }
}

async function fetchClaimsByIds(supabase: AdminClient, orgId: string, claimIds: string[]): Promise<Array<Record<string, unknown>>> {
  if (claimIds.length === 0) return []
  const { data } = await supabase
    .from('claims')
    .select('*')
    .eq('org_id', orgId)
    .in('id', claimIds)
  return (data ?? []) as Array<Record<string, unknown>>
}

export async function fetchArtifactById(supabase: AdminClient, orgId: string, artifactId: string): Promise<SourceArtifact | null> {
  const { data } = await supabase
    .from('source_artifacts')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', artifactId)
    .maybeSingle()

  return data ? mapSourceArtifact(data) : null
}

export async function fetchEvidenceForArtifact(supabase: AdminClient, orgId: string, artifactId: string): Promise<EvidenceItem[]> {
  const { data } = await supabase
    .from('evidence_items')
    .select('*')
    .eq('org_id', orgId)
    .eq('artifact_id', artifactId)
    .order('sequence_no', { ascending: true })

  return (data ?? []).map(mapEvidenceItem)
}

async function fetchEntityById(
  supabase: AdminClient,
  orgId: string,
  entityId: string
): Promise<{ id: string; name: string; entityType: string; description: string | null; attributes?: Record<string, unknown> | null } | null> {
  const { data } = await supabase
    .from('entities')
    .select('id, name, entity_type, description, attributes')
    .eq('org_id', orgId)
    .eq('id', entityId)
    .maybeSingle()

  if (!data) return null

  return {
    id: stringFromUnknown(data.id),
    name: stringFromUnknown(data.name),
    entityType: stringFromUnknown(data.entity_type),
    description: nullableString(data.description),
    attributes: objectValue(data.attributes),
  }
}

async function fetchClaimsForEntity(supabase: AdminClient, orgId: string, entityId: string): Promise<Array<Record<string, unknown>>> {
  const { data } = await supabase
    .from('claims')
    .select('*')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .is('valid_to', null)
    .or(`subject_entity_id.eq.${entityId},object_entity_id.eq.${entityId}`)
    .order('valid_from', { ascending: false })
    .limit(25)

  return (data ?? []) as Array<Record<string, unknown>>
}

async function fetchCommitmentsForEntity(supabase: AdminClient, orgId: string, entityId: string): Promise<Array<Record<string, unknown>>> {
  const [relatedRes, ownerRes] = await Promise.all([
    supabase
      .from('commitments')
      .select('*')
      .eq('org_id', orgId)
      .contains('related_entity_ids', [entityId])
      .order('updated_at', { ascending: false })
      .limit(50),
    supabase
      .from('commitments')
      .select('*')
      .eq('org_id', orgId)
      .eq('owner_entity_id', entityId)
      .order('updated_at', { ascending: false })
      .limit(50),
  ])

  const merged = [...(relatedRes.data ?? []), ...(ownerRes.data ?? [])] as Array<Record<string, unknown>>
  const unique = new Map<string, Record<string, unknown>>()
  for (const commitment of merged) {
    const id = stringFromUnknown(commitment.id)
    if (id) unique.set(id, commitment)
  }

  return [...unique.values()]
}

async function fetchDecisionThreadsForEntity(supabase: AdminClient, orgId: string, entityId: string): Promise<Array<Record<string, unknown>>> {
  const { data } = await supabase
    .from('decision_threads')
    .select('*')
    .eq('org_id', orgId)
    .contains('related_entity_ids', [entityId])
    .order('updated_at', { ascending: false })
    .limit(50)

  return (data ?? []) as Array<Record<string, unknown>>
}

export function sanitizeMemoryCategory(category: string): string {
  const normalized = category.trim().toLowerCase()
  return VALID_MEMORY_CATEGORIES.has(normalized) ? normalized : 'context'
}

export function splitIntoChunks<T>(values: T[], size: number): T[][] {
  if (size <= 0) return [values]
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

async function fetchEvidenceForClaims(supabase: AdminClient, orgId: string, claimIds: string[]): Promise<EvidenceItem[]> {
  if (claimIds.length === 0) return []

  const { data: links } = await supabase
    .from('claim_evidence_links')
    .select('evidence_item_id')
    .eq('org_id', orgId)
    .in('claim_id', claimIds)

  const evidenceItemIds = Array.from(new Set<string>(
    (links ?? [])
      .map((link: Record<string, unknown>) => stringFromUnknown(link.evidence_item_id))
      .filter(isNonEmptyString)
  ))
  return fetchEvidenceItemsByIds(supabase, orgId, evidenceItemIds)
}

async function fetchCommitmentById(supabase: AdminClient, orgId: string, commitmentId: string): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from('commitments')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', commitmentId)
    .maybeSingle()

  return (data as Record<string, unknown> | null) ?? null
}

async function fetchDecisionThreadById(supabase: AdminClient, orgId: string, decisionThreadId: string): Promise<any | null> {
  const { data } = await supabase
    .from('decision_threads')
    .select('*')
    .eq('org_id', orgId)
    .eq('id', decisionThreadId)
    .maybeSingle()
  return data ?? null
}

async function findExistingCommitment(supabase: AdminClient, orgId: string, title: string): Promise<Record<string, unknown> | null> {
  const { data } = await supabase
    .from('commitments')
    .select('*')
    .eq('org_id', orgId)
    .ilike('title', title)
    .order('updated_at', { ascending: false })
    .limit(5)

  return ((data ?? []) as Array<Record<string, unknown>>).find(row => normalizeRef(stringFromUnknown(row.title)) === normalizeRef(title)) ?? null
}

function pickCurrentClaimId(
  claims: Array<Record<string, unknown>>,
  hint: string,
  claimKind: string,
  title: string
): string | null {
  const normalizedHint = normalizeRef(hint || title)
  const match = claims.find(claim => {
    if (stringFromUnknown(claim.claim_kind) !== claimKind) return false
    const haystack = `${stringFromUnknown(claim.predicate)} ${stringFromUnknown(claim.object_value)}`.toLowerCase()
    return haystack.includes(normalizedHint)
  })
  return match ? stringFromUnknown(match.id) : null
}

function pickClaimIdsByPredicates(
  claims: Array<Record<string, unknown>>,
  predicates: string[]
): string[] {
  if (predicates.length === 0) return claims.map(claim => stringFromUnknown(claim.id)).filter(Boolean).slice(0, 5)
  const normalizedPredicates = predicates.map(normalizeRef)
  return claims
    .filter(claim => normalizedPredicates.includes(normalizeRef(stringFromUnknown(claim.predicate))))
    .map(claim => stringFromUnknown(claim.id))
    .filter(Boolean)
}

function mapSourceArtifact(row: Record<string, unknown>): SourceArtifact {
  return {
    id: stringFromUnknown(row.id),
    orgId: stringFromUnknown(row.org_id),
    channel: row.channel as SourceArtifact['channel'],
    externalId: stringFromUnknown(row.external_id),
    title: stringFromUnknown(row.title),
    sourceUrl: nullableString(row.source_url),
    startedAt: nullableString(row.started_at),
    endedAt: nullableString(row.ended_at),
    rawRef: nullableString(row.raw_ref),
    metadata: objectValue(row.metadata) ?? {},
  }
}

function mapEvidenceItem(row: Record<string, unknown>): EvidenceItem {
  return {
    id: stringFromUnknown(row.id),
    artifactId: stringFromUnknown(row.artifact_id),
    orgId: stringFromUnknown(row.org_id),
    sequenceNo: numericValue(row.sequence_no, 0),
    authorName: nullableString(row.author_name),
    authorEntityId: nullableString(row.author_entity_id),
    happenedAt: nullableString(row.happened_at),
    text: stringFromUnknown(row.text),
    sourceAnchor: stringFromUnknown(row.source_anchor),
    metadata: objectValue(row.metadata) ?? {},
  }
}

function normalizeRef(value: string): string {
  return normalizeCanonical(value.replace(/^entity_id:/, '').replace(/^entity:/, ''))
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item)).filter(Boolean)
}

function stringFromUnknown(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numericValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isNonEmptyString(value: string): value is string {
  return value.length > 0
}
