import type { ArtifactChannel, ClaimKind, MutationBundle } from '@/lib/evidence/schema'

export interface SourceArtifact {
  id: string
  orgId: string
  channel: ArtifactChannel
  externalId: string
  title: string
  sourceUrl: string | null
  startedAt: string | null
  endedAt: string | null
  rawRef: string | null
  metadata: Record<string, unknown>
}

export interface EvidenceItem {
  id: string
  artifactId: string
  orgId: string
  sequenceNo: number
  authorName: string | null
  authorEntityId: string | null
  happenedAt: string | null
  text: string
  sourceAnchor: string
  metadata: Record<string, unknown>
}

export interface ClaimRecord {
  id: string
  orgId: string
  artifactId: string | null
  claimKey: string
  claimKind: ClaimKind
  subjectEntityId: string
  predicate: string
  objectEntityId: string | null
  objectValue: string | null
  confidence: number
  evidenceStatus: 'supported' | 'context_only' | 'manual'
  status: 'active' | 'superseded' | 'disputed' | 'retracted'
  validFrom: string
  validTo: string | null
  metadata: Record<string, unknown>
}

export interface DecisionThreadRecord {
  id: string
  orgId: string
  title: string
  canonicalTitle: string
  status: 'open' | 'resolved' | 'superseded' | 'cancelled'
  currentClaimId: string | null
  firstArtifactId: string | null
  lastArtifactId: string | null
  relatedEntityIds: string[]
  metadata: Record<string, unknown>
}

export interface VaultDocumentRecord {
  id: string
  orgId: string
  path: string
  title: string
  documentType: 'source_artifact' | 'entity' | 'commitment' | 'decision_thread' | 'timeline' | 'narrative'
  contentMarkdown: string
  frontmatter: Record<string, unknown>
  sourceMode: 'generated' | 'manual' | 'hybrid'
  metadata: Record<string, unknown>
}

export interface ContextPack {
  matchedEntityIds: string[]
  matchedEntities: Array<{
    id: string
    name: string
    entityType: string
    description: string | null
  }>
  activeClaims: ClaimRecord[]
  evidenceItems: EvidenceItem[]
  commitments: Array<Record<string, unknown>>
  decisionThreads: DecisionThreadRecord[]
  narratives: Array<Record<string, unknown>>
  memories: Array<Record<string, unknown>>
  vaultDocuments: VaultDocumentRecord[]
  recentArtifacts: Array<Record<string, unknown>>
  contextBlock: string | null
}

export interface EvidencePipelineParams {
  orgId: string
  source:
    | {
        kind: 'meeting'
        meeting: Record<string, unknown>
        segments: Array<Record<string, unknown>>
        summary?: Record<string, unknown> | null
        actionItems?: Array<Record<string, unknown>>
        decisions?: Array<Record<string, unknown>>
      }
    | {
        kind: 'chat'
        conversation: Record<string, unknown>
        messages: Array<Record<string, unknown>>
        toolOutputs?: Array<{ toolName: string; output: string }>
      }
    | {
        kind: 'email'
        provider: 'gmail' | 'microsoft_365'
        thread: Record<string, unknown>
        messages: Array<Record<string, unknown>>
      }
    | {
        kind: 'slack'
        conversation: Record<string, unknown>
        messages: Array<Record<string, unknown>>
      }
  compatibility?: {
    conversationId?: string | null
    messageId?: string | null
    role?: 'user' | 'assistant'
    injectedEntityIds?: string[]
  }
}

export interface EvidencePipelineResult {
  artifactId: string
  evidenceItemIds: string[]
  bundle: MutationBundle | null
  affectedVaultPaths: string[]
}
