export interface IntelligenceVaultTreeNode {
  name: string
  path: string
  type: 'folder' | 'document'
  children?: IntelligenceVaultTreeNode[]
}

export interface IntelligenceVaultEntryPoint {
  path: string
  title: string
  documentType: string
  updatedAt: string
  lastSourceUpdateAt: string | null
  summary?: string | null
  manualSectionSummaries?: string[]
}

export interface IntelligenceInitiativeEntry {
  id: string
  title: string
  status: string
  phase: string
  nextMilestone: string | null
  nextReviewAt: string | null
  lastSignalAt: string | null
  lastReconciledAt?: string | null
  latestSummary: string | null
  currentHypothesis?: string | null
  openQuestionCount: number
  riskCount: number
}

interface InitiativeLike {
  title: string
  latestSummary: string | null
}

const CHANNEL_LABELS: Record<string, string> = {
  meeting: 'meeting',
  email: 'email',
  slack: 'Slack',
  chat: 'chat',
}

const CHANNEL_ORDER: Record<string, number> = {
  meeting: 0,
  email: 1,
  slack: 2,
  chat: 3,
}

/**
 * Flatten nested vault tree nodes into a document path list while preserving tree order.
 */
export function flattenVaultDocumentPaths(nodes: IntelligenceVaultTreeNode[]): string[] {
  const paths: string[] = []

  for (const node of nodes) {
    if (node.type === 'document') {
      paths.push(node.path)
      continue
    }

    if (Array.isArray(node.children) && node.children.length > 0) {
      paths.push(...flattenVaultDocumentPaths(node.children))
    }
  }

  return paths
}

/**
 * Build a compact readable summary of synced artifact channels.
 */
export function summarizeArtifactChannels(channels: string[]): string {
  if (channels.length === 0) {
    return 'No synced sources yet'
  }

  const counts = new Map<string, number>()
  for (const channel of channels) {
    counts.set(channel, (counts.get(channel) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return (CHANNEL_ORDER[left[0]] ?? 99) - (CHANNEL_ORDER[right[0]] ?? 99)
    })
    .map(([channel, count]) => {
      const baseLabel = CHANNEL_LABELS[channel] ?? channel
      const label = count === 1
        ? baseLabel
        : baseLabel === 'Slack'
          ? 'Slack threads'
          : `${baseLabel}s`
      return `${count} ${label}`
    })
    .join(', ')
}

export function groupEntryPointsByFreshness(entries: IntelligenceVaultEntryPoint[]): {
  fresh: IntelligenceVaultEntryPoint[]
  older: IntelligenceVaultEntryPoint[]
} {
  const now = Date.now()
  const fresh: IntelligenceVaultEntryPoint[] = []
  const older: IntelligenceVaultEntryPoint[] = []

  for (const entry of entries) {
    const ageHours = (now - new Date(entry.updatedAt).getTime()) / 3_600_000
    if (ageHours <= 48) {
      fresh.push(entry)
    } else {
      older.push(entry)
    }
  }

  return { fresh, older }
}

export function dedupeEntryPoints(entries: IntelligenceVaultEntryPoint[]): IntelligenceVaultEntryPoint[] {
  const byKey = new Map<string, IntelligenceVaultEntryPoint>()

  for (const entry of entries) {
    const key = `${entry.documentType}:${entry.title.trim().toLowerCase()}`
    const existing = byKey.get(key)
    if (!existing || existing.updatedAt < entry.updatedAt) {
      byKey.set(key, entry)
    }
  }

  return [...byKey.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function labelDocumentType(documentType: string): string {
  switch (documentType) {
    case 'source_artifact':
      return 'Source'
    case 'decision_thread':
      return 'Decision'
    case 'commitment':
      return 'Action item'
    case 'brief':
      return 'Brief'
    case 'narrative':
      return 'Narrative'
    case 'initiative':
      return 'Initiative'
    default:
      return documentType.replace(/_/g, ' ')
  }
}

export function prioritizeInitiatives(
  entries: IntelligenceInitiativeEntry[],
  now: string = new Date().toISOString()
): IntelligenceInitiativeEntry[] {
  const nowMs = new Date(now).getTime()

  return [...entries].sort((left, right) => {
    const score = (entry: IntelligenceInitiativeEntry): number => {
      const reviewScore = entry.nextReviewAt && new Date(entry.nextReviewAt).getTime() <= nowMs ? 6 : 0
      const statusScore =
        entry.status === 'blocked' ? 5
        : entry.status === 'active' ? 4
        : entry.status === 'waiting' ? 2
        : 0
      const phaseScore = entry.phase === 'execution' ? 3 : entry.phase === 'planning' ? 2 : 1
      const freshnessScore = entry.lastSignalAt
        ? Math.max(0, 3 - Math.floor((nowMs - new Date(entry.lastSignalAt).getTime()) / 86_400_000))
        : 0
      const riskScore = Math.min(entry.riskCount, 3)
      const questionScore = Math.min(entry.openQuestionCount, 2)
      return reviewScore + statusScore + phaseScore + freshnessScore + riskScore + questionScore
    }

    const rightScore = score(right)
    const leftScore = score(left)
    if (rightScore !== leftScore) return rightScore - leftScore
    return (right.lastSignalAt ?? right.nextReviewAt ?? '').localeCompare(left.lastSignalAt ?? left.nextReviewAt ?? '')
  })
}

export function describeInitiativeState(entry: IntelligenceInitiativeEntry): string {
  const parts = [`${entry.phase} · ${entry.status}`]

  if (entry.nextMilestone) parts.push(`next: ${entry.nextMilestone}`)
  if (entry.openQuestionCount > 0) parts.push(`${entry.openQuestionCount} open question${entry.openQuestionCount === 1 ? '' : 's'}`)
  if (entry.riskCount > 0) parts.push(`${entry.riskCount} risk${entry.riskCount === 1 ? '' : 's'}`)

  return parts.join(' · ')
}

export function explainInitiativePriority(entry: IntelligenceInitiativeEntry, now: string = new Date().toISOString()): string {
  const reasons: string[] = []
  const nowMs = new Date(now).getTime()

  if (entry.status === 'blocked') reasons.push('It is currently blocked.')
  if (entry.status === 'active') reasons.push('It is active work.')
  if (entry.nextReviewAt && new Date(entry.nextReviewAt).getTime() <= nowMs) {
    reasons.push('It is due for review now.')
  }
  if (entry.nextMilestone) reasons.push(`Next milestone: ${entry.nextMilestone}.`)
  if (entry.openQuestionCount > 0) reasons.push(`There ${entry.openQuestionCount === 1 ? 'is' : 'are'} ${entry.openQuestionCount} open question${entry.openQuestionCount === 1 ? '' : 's'}.`)
  if (entry.riskCount > 0) reasons.push(`There ${entry.riskCount === 1 ? 'is' : 'are'} ${entry.riskCount} known risk${entry.riskCount === 1 ? '' : 's'}.`)

  return reasons.join(' ') || 'This initiative was selected because it matches recent signals.'
}

export function findRelatedDocsForInitiative<T extends IntelligenceVaultEntryPoint>(
  initiative: InitiativeLike,
  documents: T[],
  limit: number = 6
): T[] {
  const tokens = normalizeTokens(`${initiative.title} ${initiative.latestSummary ?? ''}`)

  return [...documents]
    .filter(document => {
      const haystack = normalizeTokens(`${document.title} ${document.path}`)
      return tokens.some(token => haystack.includes(token))
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit)
}

export function findChangedDocsForInitiative<T extends IntelligenceVaultEntryPoint>(
  initiative: Pick<IntelligenceInitiativeEntry, 'lastReconciledAt' | 'lastSignalAt'>,
  documents: T[],
  limit: number = 4
): T[] {
  const baseline = initiative.lastReconciledAt ?? initiative.lastSignalAt
  const changed = [...documents]
    .filter((doc) => !baseline || doc.updatedAt > baseline)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  return changed.slice(0, limit)
}

export function summarizeInitiativeManualContext(
  documents: IntelligenceVaultEntryPoint[],
  limit: number = 4
): string[] {
  const snippets: string[] = []
  const seen = new Set<string>()

  for (const doc of documents) {
    for (const snippet of doc.manualSectionSummaries ?? []) {
      const trimmed = snippet.trim()
      if (!trimmed) continue
      const key = trimmed.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      snippets.push(trimmed)
      if (snippets.length >= limit) return snippets
    }
  }

  return snippets
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2)
}
