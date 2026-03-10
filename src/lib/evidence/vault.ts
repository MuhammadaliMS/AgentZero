import type {
  DecisionThreadRecord,
  EvidenceItem,
  SourceArtifact,
  VaultDocumentRecord,
} from '@/lib/evidence/types'

type VaultDocumentType = VaultDocumentRecord['documentType']
type VaultSourceMode = VaultDocumentRecord['sourceMode']
type VaultLinkKind = 'entity' | 'claim' | 'commitment' | 'narrative' | 'evidence_item' | 'artifact' | 'decision_thread'

export interface VaultLink {
  linkKind: VaultLinkKind
  targetId: string
}

export interface RenderedVaultDocument {
  title: string
  path: string
  documentType: VaultDocumentType
  contentMarkdown: string
  frontmatter: Record<string, unknown>
  sourceMode: VaultSourceMode
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
  project: 'Knowledge/Projects',
}

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

export function buildNarrativeVaultPath(title: string): string {
  return `Narratives/${slugifyVaultSegment(title)}.md`
}

export function renderSourceArtifactDocument(input: {
  artifact: SourceArtifact
  evidenceItems: EvidenceItem[]
}): RenderedVaultDocument {
  const participants = Array.isArray(input.artifact.metadata.participants)
    ? (input.artifact.metadata.participants as Array<{ name?: string | null; email?: string | null }>)
    : []

  const lines = [
    `# ${input.artifact.title}`,
    '',
    '## Source',
    `- Channel: ${input.artifact.channel}`,
    `- External ID: ${input.artifact.externalId}`,
    `- Started: ${input.artifact.startedAt ?? 'Unknown'}`,
  ]

  if (input.artifact.endedAt) {
    lines.push(`- Ended: ${input.artifact.endedAt}`)
  }

  if (input.artifact.sourceUrl) {
    lines.push(`- Link: ${input.artifact.sourceUrl}`)
  }

  if (participants.length > 0) {
    lines.push('', '## Participants')
    for (const participant of participants) {
      const label = participant.email ? `${participant.name} (${participant.email})` : participant.name
      if (label) lines.push(`- ${label}`)
    }
  }

  lines.push('', '## Evidence')
  for (const item of input.evidenceItems.slice(0, 200)) {
    const author = item.authorName ?? 'Unknown'
    const happenedAt = item.happenedAt ?? `sequence ${item.sequenceNo}`
    lines.push(`### ${author} · ${happenedAt}`)
    lines.push(item.text.trim())
    lines.push('')
  }

  const links: VaultLink[] = [
    { linkKind: 'artifact', targetId: input.artifact.id },
    ...input.evidenceItems.map(item => ({ linkKind: 'evidence_item' as const, targetId: item.id })),
  ]

  return {
    title: input.artifact.title,
    path: buildSourceArtifactVaultPath(input.artifact),
    documentType: 'source_artifact',
    contentMarkdown: lines.join('\n').trim(),
    frontmatter: {
      artifactId: input.artifact.id,
      artifactChannel: input.artifact.channel,
      externalId: input.artifact.externalId,
      evidenceItemIds: input.evidenceItems.map(item => item.id),
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'generated',
    metadata: {
      artifactId: input.artifact.id,
    },
    links,
  }
}

export function renderDecisionThreadDocument(input: {
  decisionThread: DecisionThreadRecord
  claims: Array<Record<string, unknown>>
  evidenceItems: EvidenceItem[]
}): RenderedVaultDocument {
  const lines = [
    `# ${input.decisionThread.title}`,
    '',
    '## Status',
    `- Current status: ${input.decisionThread.status}`,
    '',
    '## Related Entities',
    ...input.decisionThread.relatedEntityIds.map(id => `- ${id}`),
    '',
    '## Supporting Evidence',
    ...input.evidenceItems.slice(0, 20).map(item => `- ${item.authorName ?? 'Unknown'}: ${item.text.slice(0, 240)}`),
  ]

  return {
    title: input.decisionThread.title,
    path: buildDecisionThreadVaultPath(input.decisionThread.title),
    documentType: 'decision_thread',
    contentMarkdown: lines.join('\n').trim(),
    frontmatter: {
      decisionThreadId: input.decisionThread.id,
      claimIds: input.claims.map(claim => claim.id).filter(Boolean),
      evidenceItemIds: input.evidenceItems.map(item => item.id),
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'generated',
    metadata: {
      decisionThreadId: input.decisionThread.id,
    },
    links: [
      { linkKind: 'decision_thread', targetId: input.decisionThread.id },
      ...input.evidenceItems.map(item => ({ linkKind: 'evidence_item' as const, targetId: item.id })),
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

  const lines = [
    `# ${input.entity.name}`,
    '',
    '## Profile',
    `- Type: ${input.entity.entityType}`,
    `- Description: ${input.entity.description ?? 'No description yet'}`,
  ]

  if (input.entity.attributes && Object.keys(input.entity.attributes).length > 0) {
    lines.push('', '## Attributes')
    for (const [key, value] of Object.entries(input.entity.attributes)) {
      lines.push(`- ${key}: ${String(value)}`)
    }
  }

  if (input.claims.length > 0) {
    lines.push('', '## Active Claims')
    for (const claim of input.claims.slice(0, 20)) {
      const predicate = typeof claim.predicate === 'string' ? claim.predicate : 'related_to'
      const objectValue = typeof claim.object_value === 'string'
        ? claim.object_value
        : typeof claim.objectValue === 'string'
          ? claim.objectValue
          : ''
      lines.push(`- ${predicate}${objectValue ? ` -> ${objectValue}` : ''}`)
    }
  }

  if (input.commitments.length > 0) {
    lines.push('', '## Commitments')
    for (const commitment of input.commitments.slice(0, 12)) {
      lines.push(`- ${stringFromUnknown(commitment.title)} [${stringFromUnknown(commitment.status, 'open')}]`)
    }
  }

  if (input.decisionThreads.length > 0) {
    lines.push('', '## Decision Threads')
    for (const thread of input.decisionThreads.slice(0, 12)) {
      lines.push(`- ${stringFromUnknown(thread.title)} [${stringFromUnknown(thread.status, 'open')}]`)
    }
  }

  if (input.evidenceItems.length > 0) {
    lines.push('', '## Recent Evidence')
    for (const item of input.evidenceItems.slice(0, 10)) {
      lines.push(`- ${item.authorName ?? 'Unknown'}: ${item.text.slice(0, 240)}`)
    }
  }

  return {
    title: input.entity.name,
    path: buildEntityVaultPath(input.entity),
    documentType: 'entity',
    contentMarkdown: lines.join('\n').trim(),
    frontmatter: {
      entityId: input.entity.id,
      claimIds: input.claims.map(claim => claim.id).filter(Boolean),
      commitmentIds: input.commitments.map(commitment => commitment.id).filter(Boolean),
      decisionThreadIds: input.decisionThreads.map(thread => thread.id).filter(Boolean),
      evidenceItemIds: input.evidenceItems.map(item => item.id),
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'generated',
    metadata: {
      entityId: input.entity.id,
      entityType: input.entity.entityType,
    },
    links: [
      { linkKind: 'entity', targetId: input.entity.id },
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
}): RenderedVaultDocument {
  const title = stringFromUnknown(input.commitment.title, 'Untitled commitment')
  const lines = [
    `# ${title}`,
    '',
    '## Status',
    `- Status: ${stringFromUnknown(input.commitment.status, 'open')}`,
    `- Priority: ${stringFromUnknown(input.commitment.priority, 'P2')}`,
    `- Due Date: ${stringFromUnknown(input.commitment.due_date ?? input.commitment.dueDate, 'Unscheduled')}`,
  ]

  const description = stringFromUnknown(input.commitment.description)
  if (description) {
    lines.push('', '## Description', description)
  }

  if (input.evidenceItems.length > 0) {
    lines.push('', '## Evidence')
    for (const item of input.evidenceItems.slice(0, 12)) {
      lines.push(`- ${item.authorName ?? 'Unknown'}: ${item.text.slice(0, 240)}`)
    }
  }

  return {
    title,
    path: buildCommitmentVaultPath(title),
    documentType: 'commitment',
    contentMarkdown: lines.join('\n').trim(),
    frontmatter: {
      commitmentId: stringFromUnknown(input.commitment.id),
      evidenceItemIds: input.evidenceItems.map(item => item.id),
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'generated',
    metadata: {
      commitmentId: stringFromUnknown(input.commitment.id),
    },
    links: [
      ...(typeof input.commitment.id === 'string'
        ? [{ linkKind: 'commitment' as const, targetId: input.commitment.id }]
        : []),
      ...input.evidenceItems.map(item => ({ linkKind: 'evidence_item' as const, targetId: item.id })),
    ],
  }
}

export function renderNarrativeDocument(input: {
  title: string
  content: string
  linkedIds?: string[]
}): RenderedVaultDocument {
  return {
    title: input.title,
    path: buildNarrativeVaultPath(input.title),
    documentType: 'narrative',
    contentMarkdown: `# ${input.title}\n\n${input.content.trim()}`,
    frontmatter: {
      linkedIds: input.linkedIds ?? [],
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'generated',
    metadata: {},
    links: (input.linkedIds ?? []).map(id => ({ linkKind: 'narrative', targetId: id })),
  }
}

export function renderTimelineDocument(input: {
  title: string
  claims: Array<Record<string, unknown>>
  evidenceItems: EvidenceItem[]
  path?: string
}): RenderedVaultDocument {
  const claimLinks = input.claims
    .map(claim => typeof claim.id === 'string' ? ({ linkKind: 'claim' as const, targetId: claim.id }) : null)
    .filter(isVaultLink)
  const evidenceLinks = input.evidenceItems.map(item => ({ linkKind: 'evidence_item' as const, targetId: item.id }))
  const lines = [
    `# ${input.title}`,
    '',
    '## Timeline',
  ]

  for (const claim of input.claims) {
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
    lines.push(`- ${validFrom}: ${predicate}${objectValue ? ` -> ${objectValue}` : ''}`)
  }

  if (input.evidenceItems.length > 0) {
    lines.push('', '## Supporting Evidence')
    for (const item of input.evidenceItems.slice(0, 20)) {
      lines.push(`- ${item.happenedAt ?? item.sequenceNo}: ${item.text.slice(0, 240)}`)
    }
  }

  return {
    title: input.title,
    path: input.path ?? buildTimelineVaultPath(input.title),
    documentType: 'timeline',
    contentMarkdown: lines.join('\n').trim(),
    frontmatter: {
      claimIds: input.claims.map(claim => claim.id).filter(Boolean),
      evidenceItemIds: input.evidenceItems.map(item => item.id),
      generatedAt: new Date().toISOString(),
    },
    sourceMode: 'generated',
    metadata: {},
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
