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

export interface ChiefOperationalMemoryLike {
  urgentCommitments?: Array<{
    title: string
    status: string
  }>
  blockedInitiatives?: Array<{
    title: string
    reason: string
  }>
}

export interface IntelligenceNowItem {
  title: string
  reason: string
  supportingPath?: string | null
}

export interface IntelligenceNowSummary {
  whatChanged: IntelligenceNowItem[]
  topPriorities: IntelligenceNowItem[]
  needsAttention: IntelligenceNowItem[]
  blocked: IntelligenceNowItem[]
  waiting: IntelligenceNowItem[]
  recentSources: IntelligenceVaultEntryPoint[]
  evidenceUsed: IntelligenceVaultEntryPoint[]
}

export interface IntelligenceAccountWorkspaceSummary {
  featuredAccounts: IntelligenceVaultEntryPoint[]
  relationshipDocs: IntelligenceVaultEntryPoint[]
  recentAccountChanges: IntelligenceVaultEntryPoint[]
}

export interface IntelligenceEvidenceEntry {
  title: string
  kind: string
  summary: string
  supportingPath: string
  updatedAt: string
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

export function buildIntelligenceNowSummary({
  initiatives,
  recentlyChanged,
  jumpBackIn,
  work,
  meetings,
  operationalMemory,
  now = new Date().toISOString(),
}: {
  initiatives: IntelligenceInitiativeEntry[]
  recentlyChanged: IntelligenceVaultEntryPoint[]
  jumpBackIn: IntelligenceVaultEntryPoint[]
  work: IntelligenceVaultEntryPoint[]
  meetings: IntelligenceVaultEntryPoint[]
  operationalMemory: ChiefOperationalMemoryLike | null
  now?: string
}): IntelligenceNowSummary {
  if (
    initiatives.length === 0
    && recentlyChanged.length === 0
    && jumpBackIn.length === 0
    && work.length === 0
    && meetings.length === 0
    && !operationalMemory
  ) {
    return {
      whatChanged: [],
      topPriorities: [],
      needsAttention: [],
      blocked: [],
      waiting: [],
      recentSources: [],
      evidenceUsed: [],
    }
  }

  const rankedInitiatives = prioritizeInitiatives(initiatives, now)
  const evidenceUsed = dedupeEntryPoints([...jumpBackIn, ...recentlyChanged, ...meetings]).slice(0, 6)
  const recentSources = dedupeEntryPoints(
    [...meetings, ...recentlyChanged].filter((entry) => entry.documentType === 'source_artifact' || entry.path.startsWith('Sources/'))
  ).slice(0, 5)

  const blockedByTitle = new Map(
    (operationalMemory?.blockedInitiatives ?? []).map((item) => [item.title.trim().toLowerCase(), item.reason])
  )

  const blocked = rankedInitiatives
    .filter((initiative) => initiative.status === 'blocked')
    .map((initiative) => ({
      title: initiative.title,
      reason: blockedByTitle.get(initiative.title.trim().toLowerCase())
        ?? initiative.latestSummary
        ?? 'The chief is holding this until a dependency is resolved.',
    }))
    .slice(0, 4)

  const waiting = rankedInitiatives
    .filter((initiative) => initiative.status === 'waiting')
    .map((initiative) => ({
      title: initiative.title,
      reason: initiative.latestSummary ?? 'The chief is waiting for an external update before moving this forward.',
    }))
    .slice(0, 4)

  const topPriorities = rankedInitiatives
    .slice(0, 4)
    .map((initiative) => ({
      title: initiative.title,
      reason: explainInitiativePriority(initiative, now),
    }))

  const attentionTitles = new Set<string>()
  const needsAttention: IntelligenceNowItem[] = []
  for (const initiative of rankedInitiatives) {
    const needsReview = initiative.nextReviewAt && new Date(initiative.nextReviewAt).getTime() <= new Date(now).getTime()
    const needsQuestions = initiative.openQuestionCount > 0
    const hasRisk = initiative.riskCount > 0
    if (!needsReview && !needsQuestions && !hasRisk) continue
    const reason = [
      needsReview ? 'Review is due now.' : null,
      needsQuestions ? `${initiative.openQuestionCount} open question${initiative.openQuestionCount === 1 ? '' : 's'}.` : null,
      hasRisk ? `${initiative.riskCount} risk${initiative.riskCount === 1 ? '' : 's'} to resolve.` : null,
    ].filter(Boolean).join(' ')
    attentionTitles.add(initiative.title.trim().toLowerCase())
    needsAttention.push({
      title: initiative.title,
      reason,
    })
    if (needsAttention.length >= 4) break
  }

  for (const commitment of operationalMemory?.urgentCommitments ?? []) {
    const key = commitment.title.trim().toLowerCase()
    if (attentionTitles.has(key)) continue
    needsAttention.push({
      title: commitment.title,
      reason: `Urgent commitment is currently ${commitment.status.replace(/_/g, ' ')}.`,
      supportingPath: work.find((entry) => entry.title.trim().toLowerCase() === key)?.path ?? null,
    })
    attentionTitles.add(key)
    if (needsAttention.length >= 4) break
  }

  const whatChanged = dedupeEntryPoints(recentlyChanged)
    .slice(0, 5)
    .map((entry) => ({
      title: entry.title,
      reason: entry.summary ?? `${labelDocumentType(entry.documentType)} updated ${relativeTimeLabel(entry.updatedAt)}.`,
      supportingPath: entry.path,
    }))

  return {
    whatChanged,
    topPriorities,
    needsAttention,
    blocked,
    waiting,
    recentSources,
    evidenceUsed,
  }
}

export function buildAccountWorkspaceSummary({
  accounts,
  relationships,
  recentlyChanged,
}: {
  accounts: IntelligenceVaultEntryPoint[]
  relationships: IntelligenceVaultEntryPoint[]
  recentlyChanged: IntelligenceVaultEntryPoint[]
}): IntelligenceAccountWorkspaceSummary {
  const featuredAccounts = dedupeEntryPoints(accounts)
    .sort((left, right) => {
      const leftNarrativeBoost = left.documentType === 'narrative' ? 1 : 0
      const rightNarrativeBoost = right.documentType === 'narrative' ? 1 : 0
      if (rightNarrativeBoost !== leftNarrativeBoost) return rightNarrativeBoost - leftNarrativeBoost
      return right.updatedAt.localeCompare(left.updatedAt)
    })
    .slice(0, 8)

  const relationshipDocs = dedupeEntryPoints(relationships).slice(0, 8)
  const accountPaths = new Set(featuredAccounts.map((entry) => entry.path))
  const relationshipPaths = new Set(relationshipDocs.map((entry) => entry.path))
  const recentAccountChanges = dedupeEntryPoints(recentlyChanged)
    .filter((entry) => accountPaths.has(entry.path) || relationshipPaths.has(entry.path))
    .slice(0, 8)

  return {
    featuredAccounts,
    relationshipDocs,
    recentAccountChanges,
  }
}

export function buildEvidenceFeed({
  meetings,
  recentlyChanged,
  work,
}: {
  meetings: IntelligenceVaultEntryPoint[]
  recentlyChanged: IntelligenceVaultEntryPoint[]
  work: IntelligenceVaultEntryPoint[]
}): IntelligenceEvidenceEntry[] {
  const changedWorkByTitle = new Map(
    dedupeEntryPoints(work).map((entry) => [entry.title.trim().toLowerCase(), entry])
  )

  return dedupeEntryPoints([...meetings, ...recentlyChanged])
    .filter((entry) => entry.documentType === 'source_artifact' || entry.path.startsWith('Sources/'))
    .map((entry) => {
      const relatedWork = [...changedWorkByTitle.values()].find((workEntry) => {
        const sourceTokens = normalizeTokens(`${entry.title} ${entry.summary ?? ''}`)
        const workTokens = normalizeTokens(`${workEntry.title} ${workEntry.summary ?? ''}`)
        return sourceTokens.some((token) => workTokens.includes(token))
      })

      return {
        title: entry.title,
        kind: labelDocumentType(entry.documentType),
        summary: relatedWork
          ? `${entry.summary ?? 'New source evidence arrived.'} This also touched ${relatedWork.title}.`
          : entry.summary ?? 'New source evidence arrived and may have changed the chief view.',
        supportingPath: entry.path,
        updatedAt: entry.updatedAt,
      }
    })
    .slice(0, 12)
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2)
}

function relativeTimeLabel(iso: string | null | undefined): string {
  if (!iso) return 'recently'
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
