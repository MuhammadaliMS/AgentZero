import type { Json } from '@/types/database'

import { mutationBundleSchema } from '@/lib/evidence/schema'
import type { EvidencePipelineParams } from '@/lib/evidence/types'
import { createUntypedAdminClient } from '@/lib/supabase/admin'
import { EVIDENCE_JOB_STAGES, getNextEvidenceJobStage, type EvidenceJobStage, type EvidenceJobStatus } from '@/lib/evidence/job-state'
import {
  runChannelAnalyst,
  runStateSynthesizer,
} from '@/lib/evidence/agents'
import { buildEvidenceContextPack } from '@/lib/evidence/context-pack'
import {
  type AppliedMutationResult,
  applyMutationBundle,
  fetchArtifactById,
  fetchEvidenceForArtifact,
  regenerateVaultDocuments,
  upsertEvidenceItems,
  upsertSourceArtifact,
} from '@/lib/evidence/store'
import {
  buildEvidenceSearchText,
  linkMeetingCanonicalRecords,
  normalizeSource,
} from '@/lib/evidence/pipeline'

type AdminClient = ReturnType<typeof createUntypedAdminClient>

export interface EvidenceJobRecord {
  id: string
  orgId: string
  sourceKind: EvidencePipelineParams['source']['kind']
  currentStage: EvidenceJobStage
  status: EvidenceJobStatus
  payload: EvidencePipelineParams['source']
  compatibility: EvidencePipelineParams['compatibility'] | null
  sourceSummary: Record<string, unknown> | null
  analystBundle: Record<string, unknown> | null
  appliedSummary: Record<string, unknown> | null
  artifactId: string | null
  attempts: number
  maxAttempts: number
  lastError: string | null
}

export interface EvidenceJobProcessResult {
  processed: boolean
  jobId: string | null
  stage: EvidenceJobStage | null
  status: EvidenceJobStatus | null
  hasPendingJobs: boolean
}

export async function enqueueEvidenceJob(params: {
  orgId: string
  source: EvidencePipelineParams['source']
  compatibility?: EvidencePipelineParams['compatibility']
}): Promise<EvidenceJobRecord> {
  const admin = createUntypedAdminClient()
  const { data, error } = await admin
    .from('evidence_jobs')
    .insert({
      org_id: params.orgId,
      source_kind: params.source.kind,
      current_stage: 'ingest',
      status: 'queued',
      payload: params.source as unknown as Json,
      compatibility: (params.compatibility ?? {}) as unknown as Json,
    })
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(`Failed to enqueue evidence job: ${error?.message ?? 'unknown error'}`)
  }

  return mapEvidenceJob(data)
}

export async function processNextEvidenceJob(jobId?: string): Promise<EvidenceJobProcessResult> {
  const admin = createUntypedAdminClient()
  const job = jobId
    ? await claimSpecificEvidenceJob(admin, jobId)
    : await claimQueuedEvidenceJob(admin)

  if (!job) {
    return {
      processed: false,
      jobId: null,
      stage: null,
      status: null,
      hasPendingJobs: false,
    }
  }

  try {
    switch (job.currentStage) {
      case 'ingest':
        await runIngestStage(admin, job)
        break
      case 'analyze':
        await runAnalyzeStage(admin, job)
        break
      case 'finalize':
        await runFinalizeStage(admin, job)
        break
      case 'write_vault':
        await runWriteVaultStage(admin, job)
        break
      default:
        throw new Error(`Unsupported evidence job stage: ${job.currentStage}`)
    }
  } catch (error) {
    await admin
      .from('evidence_jobs')
      .update({
        status: 'failed',
        last_error: (error as Error).message.slice(0, 1000),
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)

    return {
      processed: true,
      jobId: job.id,
      stage: job.currentStage,
      status: 'failed',
      hasPendingJobs: await hasQueuedEvidenceJobs(admin),
    }
  }

  const refreshed = await fetchEvidenceJobById(admin, job.id)
  return {
    processed: true,
    jobId: job.id,
    stage: refreshed?.currentStage ?? job.currentStage,
    status: refreshed?.status ?? job.status,
    hasPendingJobs: await hasQueuedEvidenceJobs(admin),
  }
}

export function triggerEvidenceJobProcessor(jobId?: string): Promise<Response> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
  if (!appUrl || !process.env.CRON_SECRET) {
    return Promise.reject(new Error('NEXT_PUBLIC_APP_URL/VERCEL_URL or CRON_SECRET not configured'))
  }

  const url = new URL('/api/cron/evidence-jobs', appUrl)
  if (jobId) url.searchParams.set('job_id', jobId)

  return fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
    },
  })
}

async function runIngestStage(admin: AdminClient, job: EvidenceJobRecord): Promise<void> {
  const normalized = normalizeSource({
    orgId: job.orgId,
    source: job.payload,
    compatibility: job.compatibility ?? undefined,
  })

  const artifact = await upsertSourceArtifact(admin, normalized.artifact)
  const evidenceItems = await upsertEvidenceItems(admin, {
    orgId: job.orgId,
    artifactId: artifact.id,
    evidenceItems: normalized.evidenceItems,
    artifact: normalized.artifact,
    sourceSummary: normalized.sourceSummary,
  })

  await advanceEvidenceJob(admin, job, {
    artifactId: artifact.id,
    sourceSummary: normalized.sourceSummary,
    stageMetrics: {
      evidenceItemCount: evidenceItems.length,
    },
  })
}

async function runAnalyzeStage(admin: AdminClient, job: EvidenceJobRecord): Promise<void> {
  if (!job.artifactId) throw new Error('Evidence job missing artifact_id for analyze stage')

  const artifact = await fetchArtifactById(admin, job.orgId, job.artifactId)
  if (!artifact) throw new Error(`Artifact not found for evidence job ${job.id}`)

  const evidenceItems = await fetchEvidenceForArtifact(admin, job.orgId, job.artifactId)
  const contextPack = await buildEvidenceContextPack({
    orgId: job.orgId,
    artifactId: artifact.id,
    searchText: buildEvidenceSearchText({
      artifactTitle: artifact.title,
      evidenceItems,
      sourceSummary: job.sourceSummary,
    }),
  })

  const analystBundle = await runChannelAnalyst({
    artifact,
    evidenceItems,
    contextPack,
    sourceSummary: job.sourceSummary,
  })

  await advanceEvidenceJob(admin, job, {
    analystBundle: analystBundle as unknown as Record<string, unknown> | null,
    stageMetrics: {
      matchedEntityCount: contextPack.matchedEntityIds.length,
      evidenceItemCount: evidenceItems.length,
      analystEntityCount: analystBundle?.entities.length ?? 0,
      analystClaimCount: analystBundle?.claims.length ?? 0,
    },
  })
}

async function runFinalizeStage(admin: AdminClient, job: EvidenceJobRecord): Promise<void> {
  if (!job.artifactId) throw new Error('Evidence job missing artifact_id for finalize stage')

  const artifact = await fetchArtifactById(admin, job.orgId, job.artifactId)
  if (!artifact) throw new Error(`Artifact not found for evidence job ${job.id}`)

  const evidenceItems = await fetchEvidenceForArtifact(admin, job.orgId, job.artifactId)
  const contextPack = await buildEvidenceContextPack({
    orgId: job.orgId,
    artifactId: artifact.id,
    searchText: buildEvidenceSearchText({
      artifactTitle: artifact.title,
      evidenceItems,
      sourceSummary: job.sourceSummary,
    }),
  })

  const analystBundle = job.analystBundle
    ? mutationBundleSchema.parse(job.analystBundle)
    : null

  const finalBundle = analystBundle
    ? await runStateSynthesizer({
      artifact,
      evidenceItems,
      contextPack,
      analystBundle,
      sourceSummary: job.sourceSummary,
    }) ?? analystBundle
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

  const applied = await applyMutationBundle(admin, {
    orgId: job.orgId,
    artifactId: artifact.id,
    bundle: mutationBundleSchema.parse(finalBundle),
    persistedEvidenceItems: evidenceItems,
    contextPack,
  })

  if (job.payload.kind === 'meeting') {
    await linkMeetingCanonicalRecords(admin, {
      orgId: job.orgId,
      meetingId: String(job.payload.meeting.id),
      artifactId: artifact.id,
      evidenceItems,
      applied,
    })
  }

  await advanceEvidenceJob(admin, job, {
    appliedSummary: serializeAppliedMutationResult(applied),
    stageMetrics: {
      claimCount: applied.claimIds.length,
      entityCount: applied.entityIds.length,
      commitmentCount: applied.commitmentIds.length,
      decisionThreadCount: applied.decisionThreadIds.length,
    },
  })
}

async function runWriteVaultStage(admin: AdminClient, job: EvidenceJobRecord): Promise<void> {
  if (!job.artifactId) throw new Error('Evidence job missing artifact_id for write_vault stage')
  if (!job.appliedSummary) throw new Error('Evidence job missing applied_summary for write_vault stage')

  const applied = deserializeAppliedMutationResult(job.appliedSummary)
  const affectedVaultPaths = await regenerateVaultDocuments(admin, {
    orgId: job.orgId,
    artifactId: job.artifactId,
    applied,
  })

  await admin
    .from('evidence_jobs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      stage_metrics: {
        ...(
          {
            claimCount: applied.claimIds.length,
            entityCount: applied.entityIds.length,
            commitmentCount: applied.commitmentIds.length,
            decisionThreadCount: applied.decisionThreadIds.length,
            vaultDocumentCount: affectedVaultPaths.length,
          }
        ),
      } as unknown as Json,
    })
    .eq('id', job.id)
}

async function advanceEvidenceJob(
  admin: AdminClient,
  job: EvidenceJobRecord,
  updates: {
    artifactId?: string | null
    sourceSummary?: Record<string, unknown> | null
    analystBundle?: Record<string, unknown> | null
    appliedSummary?: Record<string, unknown> | null
    stageMetrics?: Record<string, unknown>
  }
): Promise<void> {
  const nextStage = getNextEvidenceJobStage(job.currentStage)
  if (!nextStage) {
    throw new Error(`No next stage for evidence job ${job.id}`)
  }

  await admin
    .from('evidence_jobs')
    .update({
      artifact_id: updates.artifactId ?? job.artifactId,
      source_summary: (updates.sourceSummary ?? job.sourceSummary ?? null) as unknown as Json,
      analyst_bundle: (updates.analystBundle ?? job.analystBundle ?? null) as unknown as Json,
      applied_summary: (updates.appliedSummary ?? job.appliedSummary ?? null) as unknown as Json,
      stage_metrics: (updates.stageMetrics ?? {}) as unknown as Json,
      current_stage: nextStage,
      status: 'queued',
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
}

async function claimQueuedEvidenceJob(admin: AdminClient): Promise<EvidenceJobRecord | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data: candidates } = await admin
      .from('evidence_jobs')
      .select('*')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1)

    const candidate = candidates?.[0]
    if (!candidate) return null

    const { data } = await admin
      .from('evidence_jobs')
      .update({
        status: 'processing',
        attempts: Number(candidate.attempts ?? 0) + 1,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', candidate.id)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle()

    if (data) return mapEvidenceJob(data)
  }

  return null
}

async function claimSpecificEvidenceJob(admin: AdminClient, jobId: string): Promise<EvidenceJobRecord | null> {
  const { data } = await admin
    .from('evidence_jobs')
    .update({
      status: 'processing',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .eq('status', 'queued')
    .select('*')
    .maybeSingle()

  return data ? mapEvidenceJob(data) : null
}

async function fetchEvidenceJobById(admin: AdminClient, jobId: string): Promise<EvidenceJobRecord | null> {
  const { data } = await admin
    .from('evidence_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle()

  return data ? mapEvidenceJob(data) : null
}

async function hasQueuedEvidenceJobs(admin: AdminClient): Promise<boolean> {
  const { count } = await admin
    .from('evidence_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'queued')

  return (count ?? 0) > 0
}

function mapEvidenceJob(row: Record<string, unknown>): EvidenceJobRecord {
  return {
    id: stringFromUnknown(row.id),
    orgId: stringFromUnknown(row.org_id),
    sourceKind: row.source_kind as EvidencePipelineParams['source']['kind'],
    currentStage: row.current_stage as EvidenceJobStage,
    status: row.status as EvidenceJobStatus,
    payload: row.payload as EvidencePipelineParams['source'],
    compatibility: objectValue(row.compatibility) as EvidencePipelineParams['compatibility'] | null,
    sourceSummary: objectValue(row.source_summary),
    analystBundle: objectValue(row.analyst_bundle),
    appliedSummary: objectValue(row.applied_summary),
    artifactId: nullableString(row.artifact_id),
    attempts: numericValue(row.attempts, 0),
    maxAttempts: numericValue(row.max_attempts, 5),
    lastError: nullableString(row.last_error),
  }
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

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item)).filter(Boolean)
}

function serializeAppliedMutationResult(result: AppliedMutationResult): Record<string, unknown> {
  return {
    artifactId: result.artifactId,
    evidenceItemIds: result.evidenceItemIds,
    claimIds: result.claimIds,
    entityIds: result.entityIds,
    decisionThreadIds: result.decisionThreadIds,
    commitmentIds: result.commitmentIds,
    memoryIds: result.memoryIds,
    affectedVaultPaths: result.affectedVaultPaths,
  }
}

function deserializeAppliedMutationResult(value: Record<string, unknown>): AppliedMutationResult {
  return {
    artifactId: String(value.artifactId ?? ''),
    evidenceItemIds: arrayOfStrings(value.evidenceItemIds),
    claimIds: arrayOfStrings(value.claimIds),
    entityIds: arrayOfStrings(value.entityIds),
    decisionThreadIds: arrayOfStrings(value.decisionThreadIds),
    commitmentIds: arrayOfStrings(value.commitmentIds),
    memoryIds: arrayOfStrings(value.memoryIds),
    affectedVaultPaths: arrayOfStrings(value.affectedVaultPaths),
    entitiesByRef: new Map(),
    commitmentsByTitle: new Map(),
    decisionThreadsByTitle: new Map(),
  }
}
