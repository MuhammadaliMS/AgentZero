import type { ArtifactChannel, ClaimKind, MutationBundle } from '@/lib/evidence/schema'

export type VaultDocumentType =
  | 'source_artifact'
  | 'entity'
  | 'commitment'
  | 'decision_thread'
  | 'timeline'
  | 'narrative'
  | 'brief'

export type VaultRenderStrategy = 'deterministic' | 'llm_assisted' | 'kimi_authored'

export type VaultSectionKind =
  | 'summary'
  | 'facts'
  | 'changes'
  | 'evidence'
  | 'timeline'
  | 'work'
  | 'links'
  | 'narrative'
  | 'brief'
  | 'manual'

export interface VaultCitation {
  label: string
  linkKind?: string | null
  targetId?: string | null
  path?: string | null
  happenedAt?: string | null
}

export interface VaultSection {
  id: string
  title: string
  kind: VaultSectionKind
  content: string
  generated: boolean
  editable: boolean
  citations?: VaultCitation[]
  updatedAt?: string | null
}

export interface VaultManualSection {
  key: string
  title: string
  content: string
  updatedAt?: string | null
}

export interface VaultNamedLink {
  linkKind: 'entity' | 'claim' | 'commitment' | 'narrative' | 'evidence_item' | 'artifact' | 'decision_thread'
  targetId: string
  targetLabel: string | null
  targetPath: string | null
  targetType: string | null
  targetMetadata: Record<string, unknown>
}

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
  documentType: VaultDocumentType
  renderStrategy: VaultRenderStrategy
  contentMarkdown: string
  frontmatter: Record<string, unknown>
  sections: VaultSection[]
  manualSections: Record<string, VaultManualSection>
  sourceMode: 'generated' | 'manual' | 'hybrid'
  stalenessReason: string | null
  lastSourceUpdateAt: string | null
  metadata: Record<string, unknown>
}

export interface VaultContextPack {
  orgId: string
  title: string
  documentType: VaultDocumentType
  entity?: {
    id: string
    name: string
    entityType: string
    description: string | null
  } | null
  artifact?: SourceArtifact | null
  claims?: ClaimRecord[]
  commitments?: Array<Record<string, unknown>>
  decisionThreads?: DecisionThreadRecord[]
  evidenceItems?: EvidenceItem[]
  recentArtifacts?: Array<Record<string, unknown>>
  previousSummary?: string | null
  manualSections?: Record<string, VaultManualSection>
}

export interface VaultWriteJob {
  orgId: string
  artifactId: string
  documentPath: string
  documentType: VaultDocumentType
  renderStrategy: VaultRenderStrategy
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
