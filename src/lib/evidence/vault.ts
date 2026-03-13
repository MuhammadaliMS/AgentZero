import type {
  DecisionThreadRecord,
  EvidenceItem,
  SourceArtifact,
  VaultDocumentRecord,
  VaultManualSection,
  VaultRenderStrategy,
  VaultSection,
} from '@/lib/evidence/types'

type VaultDocumentType = VaultDocumentRecord['documentType']
type VaultSourceMode = VaultDocumentRecord['sourceMode']
type VaultLinkKind = 'entity' | 'claim' | 'commitment' | 'narrative' | 'evidence_item' | 'artifact' | 'decision_thread'

export interface VaultLink {
  linkKind: VaultLinkKind
  targetId: string
  targetLabel?: string | null
  targetPath?: string | null
  targetType?: string | null
  targetMetadata?: Record<string, unknown>
}

export interface RenderedVaultDocument {
  title: string
  path: string
  documentType: VaultDocumentType
  renderStrategy: VaultRenderStrategy
  sections: VaultSection[]
  manualSections: Record<string, VaultManualSection>
  contentMarkdown: string
  frontmatter: Record<string, unknown>
  sourceMode: VaultSourceMode
  stalenessReason: string | null
  lastSourceUpdateAt: string | null
  metadata: Record<string, unknown>
  links: VaultLink[]
}

export interface VaultTreeNode {
  name: string
  path: string
  type: 'folder' | 'document'
  children?: VaultTreeNode[]
}

const SOURCE_FOLDER_MAP = {
  meeting: 'Sources/Meetings',
  slack: 'Sources/Slack',
  email: 'Sources/Email',
  chat: 'Sources/Chat',
} as const

const ENTITY_FOLDER_MAP: Record<string, string> = {
  person: 'Knowledge/People',
  vendor: 'Knowledge/Organizations',
  customer: 'Knowledge/Organizations',
  team: 'Knowledge/Organizations',
  tool: 'Knowledge/Tools',
  process: 'Knowledge/Processes',
  project: 'Knowledge/Projects',
}

export const DEFAULT_MANUAL_SECTION_TITLES = {
  manual_notes: 'Manual notes',
  questions: 'Questions',
  user_hypotheses: 'User hypotheses',
} as const

/**
 * Convert freeform text into a vault-safe path segment.
 */
export function slugifyVaultSegment(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    || 'untitled'
}

export function buildSourceArtifactVaultPath(input: {
  channel: SourceArtifact['channel']
  title: string
  startedAt: string | null
  externalId: string
}): string {
  const folder = SOURCE_FOLDER_MAP[input.channel]
  const datePrefix = input.startedAt ? input.startedAt.slice(0, 10) : 'undated'
  const titleSegment = slugifyVaultSegment(input.title || input.externalId)
  return `${folder}/${datePrefix}-${titleSegment}.md`
}

export function buildEntityVaultPath(entity: {
  name: string
  entityType: string
}): string {
  const folder = ENTITY_FOLDER_MAP[entity.entityType] ?? 'Knowledge/Projects'
  return `${folder}/${slugifyVaultSegment(entity.name)}.md`
}

export function buildCommitmentVaultPath(title: string): string {
  return `Work/Action Items/${slugifyVaultSegment(title)}.md`
}

export function buildDecisionThreadVaultPath(title: string): string {
  return `Work/Decision Threads/${slugifyVaultSegment(title)}.md`
}

export function buildTimelineVaultPath(title: string): string {
  return `Timelines/${slugifyVaultSegment(title)}.md`
}

export function buildNarrativeVaultPath(title: string, kind: 'account' | 'relationship' | 'initiative' = 'initiative'): string {
  const folder = kind === 'account'
    ? 'Narratives/Accounts'
    : kind === 'relationship'
      ? 'Narratives/Relationships'
      : 'Narratives/Initiatives'
  return `${folder}/${slugifyVaultSegment(title)}.md`
}

export function buildBriefVaultPath(input: { dateKey: string; scope?: string }): string {
  const suffix = input.scope ? `-${slugifyVaultSegment(input.scope)}` : ''
  return `Briefs/${input.dateKey}${suffix}.md`
}

export function createManualSections(
  existing?: Record<string, VaultManualSection>,
  allowed = true
): Record<string, VaultManualSection> {
  if (!allowed) return {}

  const next: Record<string, VaultManualSection> = {}
  for (const [key, title] of Object.entries(DEFAULT_MANUAL_SECTION_TITLES)) {
    const current = existing?.[key]
    next[key] = {
      key,
      title,
      content: current?.content ?? '',
      updatedAt: current?.updatedAt ?? null,
    }
  }
  return next
}

export function buildVaultMarkdown(
  sections: VaultSection[],
  manualSections: Record<string, VaultManualSection>
): string {
  const lines: string[] = []

  for (const section of sections) {
    lines.push(`## ${section.title}`, '')
    lines.push(section.content.trim() || '_No content yet_')

    if ((section.citations ?? []).length > 0) {
      lines.push('', 'References:')
      for (const citation of section.citations ?? []) {
        lines.push(`- ${citation.label}`)
      }
    }

    lines.push('')
  }

  for (const section of Object.values(manualSections)) {
    lines.push(`## ${section.title}`, '')
    lines.push(section.content.trim() || '_Add notes here_')
    lines.push('')
  }

  return lines.join('\n').trim()
}

export function createSection(input: Omit<VaultSection, 'generated' | 'editable'> & {
  generated?: boolean
  editable?: boolean
}): VaultSection {
  return {
    generated: input.generated ?? true,
    editable: input.editable ?? false,
    ...input,
  }
}

export function renderSourceArtifactDocument(input: {
  artifact: SourceArtifact
  evidenceItems: EvidenceItem[]
  interpretationSections?: VaultSection[]
  previousManualSections?: Record<string, VaultManualSection>
  stalenessReason?: string | null
}): RenderedVaultDocument {
  const participants = Array.isArray(input.artifact.metadata.participants)
    ? (input.artifact.metadata.participants as Array<{ name?: string | null; email?: string | null }>)
    : []

  const chronology = input.evidenceItems
    .slice(0, 80)
    .map((item) => `- ${item.authorName ?? 'Unknown'} · ${item.happenedAt ?? `sequence ${item.sequenceNo}`}: ${item.text.trim()}`)
    .join('\n')

  const sections: VaultSection[] = [
    createSection({
      id: 'source-metadata',
      title: 'Source metadata',
      kind: 'facts',
      content: [
        `- Channel: ${input.artifact.channel}`,
        `- External ID: ${input.artifact.externalId}`,
        `- Started: ${input.artifact.startedAt ?? 'Unknown'}`,
        input.artifact.endedAt ? `- Ended: ${input.artifact.endedAt}` : null,
        input.artifact.sourceUrl ? `- Link: ${input.artifact.sourceUrl}` : null,
      ].filter(Boolean).join('\n'),
    }),
    ...(participants.length > 0
      ? [createSection({
          id: 'participants',
          title: 'Participants',
          kind: 'facts',
          content: participants
            .map((participant) => participant.email
              ? `- ${participant.name ?? 'Unknown'} (${participant.email})`
              : `- ${participant.name ?? 'Unknown'}`)
            .join('\n'),
        })]
      : []),
    ...(input.interpretationSections ?? []),
    createSection({
      id: 'chronology',
      title: 'Chronology',
      kind: 'timeline',
      content: chronology || '_No chronology available_',
      citations: input.evidenceItems.slice(0, 16).map((item) => ({
        label: `${item.authorName ?? 'Unknown'} @ ${item.happenedAt ?? item.sequenceNo}`,
        linkKind: 'evidence_item',
        targetId: item.id,
        happenedAt: item.happenedAt,
      })),
    }),
  ]

  const manualSections = createManualSections(input.previousManualSections, false)

  return {
    title: input.artifact.title,
    path: buildSourceArtifactVaultPath(input.artifact),
    documentType: 'source_artifact',
    renderStrategy: 'llm_assisted',
    sections,
    manualSections,
    contentMarkdown: `# ${input.artifact.title}\n\n${buildVaultMarkdown(sections, manualSections)}`,
    frontmatter: {
      artifactId: input.artifact.id,
      artifactChannel: input.artifact.channel,
      externalId: input.artifact.externalId,
      evidenceItemIds: input.evidenceItems.map(item => item.id),
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'generated',
    stalenessReason: input.stalenessReason ?? null,
    lastSourceUpdateAt: input.artifact.endedAt ?? input.artifact.startedAt,
    metadata: {
      artifactId: input.artifact.id,
      sourceFingerprint: JSON.stringify({
        title: input.artifact.title,
        evidenceItemIds: input.evidenceItems.map(item => item.id),
      }),
      previousSummary: summarizeInterpretationSections(input.interpretationSections ?? []),
    },
    links: [
      { linkKind: 'artifact', targetId: input.artifact.id, targetLabel: input.artifact.title, targetPath: buildSourceArtifactVaultPath(input.artifact), targetType: 'meeting' },
      ...input.evidenceItems.map(item => ({
        linkKind: 'evidence_item' as const,
        targetId: item.id,
        targetLabel: `${item.authorName ?? 'Unknown'} @ ${item.happenedAt ?? item.sequenceNo}`,
        targetType: 'evidence_item',
      })),
    ],
  }
}

export function renderDecisionThreadDocument(input: {
  decisionThread: DecisionThreadRecord
  claims: Array<Record<string, unknown>>
  evidenceItems: EvidenceItem[]
  interpretationSections?: VaultSection[]
  previousManualSections?: Record<string, VaultManualSection>
}): RenderedVaultDocument {
  const sections: VaultSection[] = [
    createSection({
      id: 'decision-status',
      title: 'Decision status',
      kind: 'facts',
      content: [
        `- Current status: ${input.decisionThread.status}`,
        `- Related entities: ${input.decisionThread.relatedEntityIds.length}`,
      ].join('\n'),
    }),
    ...(input.interpretationSections ?? []),
    createSection({
      id: 'supporting-evidence',
      title: 'Supporting evidence',
      kind: 'evidence',
      content: input.evidenceItems.length > 0
        ? input.evidenceItems.slice(0, 20).map(item => `- ${item.authorName ?? 'Unknown'}: ${item.text.slice(0, 240)}`).join('\n')
        : '_No evidence linked yet_',
      citations: input.evidenceItems.slice(0, 12).map((item) => ({
        label: `${item.authorName ?? 'Unknown'} @ ${item.happenedAt ?? item.sequenceNo}`,
        linkKind: 'evidence_item',
        targetId: item.id,
      })),
    }),
  ]

  const manualSections = createManualSections(input.previousManualSections)

  return {
    title: input.decisionThread.title,
    path: buildDecisionThreadVaultPath(input.decisionThread.title),
    documentType: 'decision_thread',
    renderStrategy: 'llm_assisted',
    sections,
    manualSections,
    contentMarkdown: `# ${input.decisionThread.title}\n\n${buildVaultMarkdown(sections, manualSections)}`,
    frontmatter: {
      decisionThreadId: input.decisionThread.id,
      claimIds: input.claims.map(claim => claim.id).filter(Boolean),
      evidenceItemIds: input.evidenceItems.map(item => item.id),
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'hybrid',
    stalenessReason: null,
    lastSourceUpdateAt: stringFromUnknown(input.decisionThread.metadata.last_source_update_at) || null,
    metadata: {
      decisionThreadId: input.decisionThread.id,
      sourceFingerprint: JSON.stringify({
        status: input.decisionThread.status,
        claimIds: input.claims.map(claim => claim.id).filter(Boolean),
      }),
      previousSummary: summarizeInterpretationSections(input.interpretationSections ?? []),
    },
    links: [
      {
        linkKind: 'decision_thread',
        targetId: input.decisionThread.id,
        targetLabel: input.decisionThread.title,
        targetPath: buildDecisionThreadVaultPath(input.decisionThread.title),
        targetType: 'decision_thread',
      },
      ...input.evidenceItems.map(item => ({
        linkKind: 'evidence_item' as const,
        targetId: item.id,
        targetLabel: `${item.authorName ?? 'Unknown'} @ ${item.happenedAt ?? item.sequenceNo}`,
        targetType: 'evidence_item',
      })),
    ],
  }
}

export function renderEntityDocument(input: {
  entity: {
    id: string
    name: string
    entityType: string
    description: string | null
    attributes?: Record<string, unknown> | null
  }
  claims: Array<Record<string, unknown>>
  commitments: Array<Record<string, unknown>>
  decisionThreads: Array<Record<string, unknown>>
  evidenceItems: EvidenceItem[]
  interpretationSections?: VaultSection[]
  previousManualSections?: Record<string, VaultManualSection>
}): RenderedVaultDocument {
  const claimLinks = input.claims
    .map(claim => typeof claim.id === 'string' ? ({ linkKind: 'claim' as const, targetId: claim.id }) : null)
    .filter(isVaultLink)
  const commitmentLinks = input.commitments
    .map(commitment => typeof commitment.id === 'string' ? ({ linkKind: 'commitment' as const, targetId: commitment.id }) : null)
    .filter(isVaultLink)
  const decisionThreadLinks = input.decisionThreads
    .map(thread => typeof thread.id === 'string' ? ({ linkKind: 'decision_thread' as const, targetId: thread.id }) : null)
    .filter(isVaultLink)
  const evidenceLinks = input.evidenceItems.map(item => ({ linkKind: 'evidence_item' as const, targetId: item.id }))

  const sections: VaultSection[] = [
    createSection({
      id: 'profile',
      title: 'Profile facts',
      kind: 'facts',
      content: [
        `- Type: ${input.entity.entityType}`,
        `- Description: ${input.entity.description ?? 'No description yet'}`,
        ...(input.entity.attributes && Object.keys(input.entity.attributes).length > 0
          ? Object.entries(input.entity.attributes).map(([key, value]) => `- ${key}: ${String(value)}`)
          : []),
      ].join('\n'),
    }),
    ...(input.interpretationSections ?? []),
    ...(input.claims.length > 0
      ? [createSection({
          id: 'active-claims',
          title: 'Active claims',
          kind: 'facts',
          content: input.claims.slice(0, 20).map((claim) => {
            const predicate = typeof claim.predicate === 'string' ? claim.predicate : 'related_to'
            const objectValue = typeof claim.object_value === 'string'
              ? claim.object_value
              : typeof claim.objectValue === 'string'
                ? claim.objectValue
                : ''
            return `- ${predicate}${objectValue ? ` -> ${objectValue}` : ''}`
          }).join('\n'),
        })]
      : []),
    ...(input.commitments.length > 0
      ? [createSection({
          id: 'linked-work',
          title: 'Linked work',
          kind: 'work',
          content: input.commitments.slice(0, 12).map((commitment) => `- ${stringFromUnknown(commitment.title)} [${stringFromUnknown(commitment.status, 'open')}]`).join('\n'),
        })]
      : []),
    ...(input.decisionThreads.length > 0
      ? [createSection({
          id: 'decision-threads',
          title: 'Decision threads',
          kind: 'links',
          content: input.decisionThreads.slice(0, 12).map((thread) => `- ${stringFromUnknown(thread.title)} [${stringFromUnknown(thread.status, 'open')}]`).join('\n'),
        })]
      : []),
    ...(input.evidenceItems.length > 0
      ? [createSection({
          id: 'recent-evidence',
          title: 'Recent evidence',
          kind: 'evidence',
          content: input.evidenceItems.slice(0, 10).map((item) => `- ${item.authorName ?? 'Unknown'}: ${item.text.slice(0, 240)}`).join('\n'),
          citations: input.evidenceItems.slice(0, 10).map((item) => ({
            label: `${item.authorName ?? 'Unknown'} @ ${item.happenedAt ?? item.sequenceNo}`,
            linkKind: 'evidence_item',
            targetId: item.id,
          })),
        })]
      : []),
  ]

  const manualSections = createManualSections(input.previousManualSections)

  return {
    title: input.entity.name,
    path: buildEntityVaultPath(input.entity),
    documentType: 'entity',
    renderStrategy: 'llm_assisted',
    sections,
    manualSections,
    contentMarkdown: `# ${input.entity.name}\n\n${buildVaultMarkdown(sections, manualSections)}`,
    frontmatter: {
      entityId: input.entity.id,
      claimIds: input.claims.map(claim => claim.id).filter(Boolean),
      commitmentIds: input.commitments.map(commitment => commitment.id).filter(Boolean),
      decisionThreadIds: input.decisionThreads.map(thread => thread.id).filter(Boolean),
      evidenceItemIds: input.evidenceItems.map(item => item.id),
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'hybrid',
    stalenessReason: null,
    lastSourceUpdateAt: newestEvidenceTimestamp(input.evidenceItems),
    metadata: {
      entityId: input.entity.id,
      entityType: input.entity.entityType,
      sourceFingerprint: JSON.stringify({
        claimIds: input.claims.map(claim => claim.id).filter(Boolean),
        commitmentIds: input.commitments.map(commitment => commitment.id).filter(Boolean),
        decisionThreadIds: input.decisionThreads.map(thread => thread.id).filter(Boolean),
      }),
      previousSummary: summarizeInterpretationSections(input.interpretationSections ?? []),
    },
    links: [
      { linkKind: 'entity', targetId: input.entity.id, targetLabel: input.entity.name, targetPath: buildEntityVaultPath(input.entity), targetType: input.entity.entityType },
      ...claimLinks,
      ...commitmentLinks,
      ...decisionThreadLinks,
      ...evidenceLinks,
    ],
  }
}

export function renderCommitmentDocument(input: {
  commitment: Record<string, unknown>
  evidenceItems: EvidenceItem[]
  interpretationSections?: VaultSection[]
  previousManualSections?: Record<string, VaultManualSection>
}): RenderedVaultDocument {
  const title = stringFromUnknown(input.commitment.title, 'Untitled commitment')
  const sections: VaultSection[] = [
    createSection({
      id: 'status',
      title: 'Status',
      kind: 'facts',
      content: [
        `- Status: ${stringFromUnknown(input.commitment.status, 'open')}`,
        `- Priority: ${stringFromUnknown(input.commitment.priority, 'P2')}`,
        `- Due Date: ${stringFromUnknown(input.commitment.due_date ?? input.commitment.dueDate, 'Unscheduled')}`,
      ].join('\n'),
    }),
    ...(stringFromUnknown(input.commitment.description)
      ? [createSection({
          id: 'description',
          title: 'Description',
          kind: 'facts',
          content: stringFromUnknown(input.commitment.description),
        })]
      : []),
    ...(input.interpretationSections ?? []),
    ...(input.evidenceItems.length > 0
      ? [createSection({
          id: 'latest-evidence',
          title: 'Latest evidence',
          kind: 'evidence',
          content: input.evidenceItems.slice(0, 12).map((item) => `- ${item.authorName ?? 'Unknown'}: ${item.text.slice(0, 240)}`).join('\n'),
          citations: input.evidenceItems.slice(0, 8).map((item) => ({
            label: `${item.authorName ?? 'Unknown'} @ ${item.happenedAt ?? item.sequenceNo}`,
            linkKind: 'evidence_item',
            targetId: item.id,
          })),
        })]
      : []),
  ]

  const manualSections = createManualSections(input.previousManualSections)

  return {
    title,
    path: buildCommitmentVaultPath(title),
    documentType: 'commitment',
    renderStrategy: 'llm_assisted',
    sections,
    manualSections,
    contentMarkdown: `# ${title}\n\n${buildVaultMarkdown(sections, manualSections)}`,
    frontmatter: {
      commitmentId: stringFromUnknown(input.commitment.id),
      evidenceItemIds: input.evidenceItems.map(item => item.id),
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'hybrid',
    stalenessReason: null,
    lastSourceUpdateAt: newestEvidenceTimestamp(input.evidenceItems),
    metadata: {
      commitmentId: stringFromUnknown(input.commitment.id),
      sourceFingerprint: JSON.stringify({
        status: input.commitment.status,
        dueDate: input.commitment.due_date ?? input.commitment.dueDate ?? null,
        evidenceItemIds: input.evidenceItems.map(item => item.id),
      }),
      previousSummary: summarizeInterpretationSections(input.interpretationSections ?? []),
    },
    links: [
      ...(typeof input.commitment.id === 'string'
        ? [{
            linkKind: 'commitment' as const,
            targetId: input.commitment.id,
            targetLabel: title,
            targetPath: buildCommitmentVaultPath(title),
            targetType: 'commitment',
          }]
        : []),
      ...input.evidenceItems.map(item => ({
        linkKind: 'evidence_item' as const,
        targetId: item.id,
        targetLabel: `${item.authorName ?? 'Unknown'} @ ${item.happenedAt ?? item.sequenceNo}`,
        targetType: 'evidence_item',
      })),
    ],
  }
}

export function renderNarrativeDocument(input: {
  title: string
  kind?: 'account' | 'relationship' | 'initiative'
  sections: VaultSection[]
  linkedIds?: string[]
  previousManualSections?: Record<string, VaultManualSection>
  lastSourceUpdateAt?: string | null
}): RenderedVaultDocument {
  const manualSections = createManualSections(input.previousManualSections)
  return {
    title: input.title,
    path: buildNarrativeVaultPath(input.title, input.kind ?? 'initiative'),
    documentType: 'narrative',
    renderStrategy: 'kimi_authored',
    sections: input.sections,
    manualSections,
    contentMarkdown: `# ${input.title}\n\n${buildVaultMarkdown(input.sections, manualSections)}`,
    frontmatter: {
      linkedIds: input.linkedIds ?? [],
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'hybrid',
    stalenessReason: null,
    lastSourceUpdateAt: input.lastSourceUpdateAt ?? null,
    metadata: {
      previousSummary: summarizeInterpretationSections(input.sections),
      narrativeKind: input.kind ?? 'initiative',
    },
    links: (input.linkedIds ?? []).map(id => ({ linkKind: 'narrative', targetId: id, targetLabel: input.title, targetPath: buildNarrativeVaultPath(input.title, input.kind ?? 'initiative'), targetType: 'narrative' })),
  }
}

export function renderBriefDocument(input: {
  title: string
  dateKey: string
  sections: VaultSection[]
  linkedIds?: string[]
  previousManualSections?: Record<string, VaultManualSection>
  lastSourceUpdateAt?: string | null
}): RenderedVaultDocument {
  const manualSections = createManualSections(input.previousManualSections)
  return {
    title: input.title,
    path: buildBriefVaultPath({ dateKey: input.dateKey }),
    documentType: 'brief',
    renderStrategy: 'kimi_authored',
    sections: input.sections,
    manualSections,
    contentMarkdown: `# ${input.title}\n\n${buildVaultMarkdown(input.sections, manualSections)}`,
    frontmatter: {
      linkedIds: input.linkedIds ?? [],
      generatedAt: new Date().toISOString(),
      dateKey: input.dateKey,
    },
    sourceMode: 'hybrid',
    stalenessReason: null,
    lastSourceUpdateAt: input.lastSourceUpdateAt ?? null,
    metadata: {
      previousSummary: summarizeInterpretationSections(input.sections),
      briefDate: input.dateKey,
    },
    links: (input.linkedIds ?? []).map(id => ({ linkKind: 'narrative', targetId: id, targetLabel: input.title, targetPath: buildBriefVaultPath({ dateKey: input.dateKey }), targetType: 'brief' })),
  }
}

export function renderTimelineDocument(input: {
  title: string
  claims: Array<Record<string, unknown>>
  evidenceItems: EvidenceItem[]
  path?: string
  previousManualSections?: Record<string, VaultManualSection>
}): RenderedVaultDocument {
  const claimLinks = input.claims
    .map(claim => typeof claim.id === 'string' ? ({ linkKind: 'claim' as const, targetId: claim.id }) : null)
    .filter(isVaultLink)
  const evidenceLinks = input.evidenceItems.map(item => ({ linkKind: 'evidence_item' as const, targetId: item.id }))
  const sections = [
    createSection({
      id: 'timeline',
      title: 'Timeline',
      kind: 'timeline',
      content: input.claims.map((claim) => {
        const validFrom = typeof claim.valid_from === 'string'
          ? claim.valid_from
          : typeof claim.validFrom === 'string'
            ? claim.validFrom
            : 'Unknown'
        const predicate = typeof claim.predicate === 'string' ? claim.predicate : 'observed'
        const objectValue = typeof claim.object_value === 'string'
          ? claim.object_value
          : typeof claim.objectValue === 'string'
            ? claim.objectValue
            : ''
        return `- ${validFrom}: ${predicate}${objectValue ? ` -> ${objectValue}` : ''}`
      }).join('\n') || '_No timeline events yet_',
    }),
    ...(input.evidenceItems.length > 0
      ? [createSection({
          id: 'supporting-evidence',
          title: 'Supporting evidence',
          kind: 'evidence',
          content: input.evidenceItems.slice(0, 20).map(item => `- ${item.happenedAt ?? item.sequenceNo}: ${item.text.slice(0, 240)}`).join('\n'),
          citations: input.evidenceItems.slice(0, 12).map((item) => ({
            label: `${item.authorName ?? 'Unknown'} @ ${item.happenedAt ?? item.sequenceNo}`,
            linkKind: 'evidence_item',
            targetId: item.id,
          })),
        })]
      : []),
  ]

  const manualSections = createManualSections(input.previousManualSections, false)

  return {
    title: input.title,
    path: input.path ?? buildTimelineVaultPath(input.title),
    documentType: 'timeline',
    renderStrategy: 'deterministic',
    sections,
    manualSections,
    contentMarkdown: `# ${input.title}\n\n${buildVaultMarkdown(sections, manualSections)}`,
    frontmatter: {
      claimIds: input.claims.map(claim => claim.id).filter(Boolean),
      evidenceItemIds: input.evidenceItems.map(item => item.id),
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'generated',
    stalenessReason: null,
    lastSourceUpdateAt: newestEvidenceTimestamp(input.evidenceItems),
    metadata: {
      sourceFingerprint: JSON.stringify({
        claimIds: input.claims.map(claim => claim.id).filter(Boolean),
      }),
    },
    links: [...claimLinks, ...evidenceLinks],
  }
}

export function buildVaultTree(paths: string[]): VaultTreeNode[] {
  const root: VaultTreeNode[] = []

  for (const rawPath of [...paths].sort()) {
    const segments = rawPath.split('/').filter(Boolean)
    let children = root
    let currentPath = ''

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      const isLeaf = index === segments.length - 1

      let node = children.find(child => child.name === segment)
      if (!node) {
        node = isLeaf
          ? { name: segment, path: currentPath, type: 'document' }
          : { name: segment, path: currentPath, type: 'folder', children: [] }
        children.push(node)
      }

      if (!isLeaf) {
        if (!node.children) node.children = []
        children = node.children
      }
    }
  }

  return sortTreeNodesRecursively(root)
}

export function summarizeInterpretationSections(sections: VaultSection[]): string | null {
  const summary = sections
    .filter((section) => ['summary', 'changes', 'narrative', 'brief'].includes(section.kind))
    .slice(0, 4)
    .map((section) => `${section.title}: ${section.content}`)
    .join('\n')

  return summary || null
}

function newestEvidenceTimestamp(evidenceItems: EvidenceItem[]): string | null {
  const sorted = evidenceItems
    .map((item) => item.happenedAt)
    .filter((value): value is string => Boolean(value))
    .sort()

  return sorted.at(-1) ?? null
}

function sortTreeNode(a: VaultTreeNode, b: VaultTreeNode): number {
  if (a.type !== b.type) {
    return a.type === 'folder' ? -1 : 1
  }
  return a.name.localeCompare(b.name)
}

function sortTreeNodesRecursively(nodes: VaultTreeNode[]): VaultTreeNode[] {
  return nodes
    .map(node => node.children
      ? { ...node, children: sortTreeNodesRecursively(node.children) }
      : node)
    .sort(sortTreeNode)
}

function stringFromUnknown(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function isVaultLink<T extends VaultLink>(value: T | null): value is T {
  return value !== null
}
