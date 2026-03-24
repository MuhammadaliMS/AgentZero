import type { ChiefFocusProfile } from '@/lib/intelligence/focus-profile'
import type { IntelligenceVaultEntryPoint } from '@/lib/evidence/intelligence-ui'

export type InitiativeStatus = 'active' | 'waiting' | 'blocked' | 'closed' | 'archived'
export type InitiativePhase =
  | 'discovery'
  | 'alignment'
  | 'planning'
  | 'execution'
  | 'waiting'
  | 'verification'
  | 'closed'

export interface InitiativeRecord {
  id: string
  orgId: string
  title: string
  goal: string
  scope: string | null
  status: InitiativeStatus
  phase: InitiativePhase
  successCriteria: string[]
  currentHypothesis: string | null
  openQuestions: string[]
  knownRisks: string[]
  dependencies: string[]
  stakeholders: string[]
  linkedEntityIds: string[]
  linkedClaimIds: string[]
  linkedCommitmentIds: string[]
  linkedDecisionThreadIds: string[]
  latestSummary: string | null
  nextMilestone: string | null
  nextReviewAt: string | null
  lastSignalAt: string | null
  lastReconciledAt: string | null
  source: string | null
  updatedAt?: string | null
}

export interface InitiativeDraft {
  title: string
  goal: string
  scope: string | null
  status: InitiativeStatus
  phase: InitiativePhase
  successCriteria: string[]
  currentHypothesis: string | null
  openQuestions: string[]
  knownRisks: string[]
  dependencies: string[]
  stakeholders: string[]
  linkedEntityIds: string[]
  latestSummary: string
  nextMilestone: string | null
  nextReviewAt: string
  lastSignalAt: string | null
  source: 'chief_loop'
}

export interface InitiativeDecisionInput {
  title: string
  goal?: string | null
  scope?: string | null
  status?: InitiativeStatus | null
  phase?: InitiativePhase | null
  successCriteria?: string[] | null
  currentHypothesis?: string | null
  openQuestions?: string[] | null
  knownRisks?: string[] | null
  dependencies?: string[] | null
  stakeholders?: string[] | null
  linkedEntityIds?: string[] | null
  linkedClaimIds?: string[] | null
  linkedCommitmentIds?: string[] | null
  linkedDecisionThreadIds?: string[] | null
  latestSummary?: string | null
  nextMilestone?: string | null
  nextReviewAt?: string | null
  lastSignalAt?: string | null
  source?: string | null
}

interface MinimalOutcome {
  id?: string
  title: string
  description: string | null
  priority: string
  status?: string
  createdAt?: string
  updatedAt?: string
  runId?: string | null
  steps?: Array<Record<string, unknown>>
}

interface MinimalArtifact {
  id?: string
  title: string
  channel: string
  startedAt?: string | null
}

interface MinimalEntity {
  id: string
  name: string
  entityType: string
}

interface MinimalClaim {
  id: string
  artifactId?: string | null
  predicate: string
  objectValue: string | null
  updatedAt: string
}

interface MinimalCommitment {
  id: string
  title: string
  status: string
  priority: string
  dueDate: string | null
  updatedAt: string
}

interface MinimalDecisionThread {
  id: string
  title: string
  status: string
  updatedAt: string
}

interface MinimalNarrative {
  id: string
  title: string
  summary: string
  updatedAt: string
}

export interface InitiativeArtifactLink {
  initiativeId: string
  artifactId: string
  linkReason: 'claim' | 'signal' | 'claim+signal'
}

interface RelevantInitiativesInput {
  initiatives: InitiativeRecord[]
  signalTexts: string[]
  focusTopics?: string[]
  now: string
  limit?: number
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Common English words that cause false-positive matches across unrelated content
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
  'our', 'out', 'has', 'had', 'its', 'let', 'get', 'got', 'too', 'use', 'may', 'did',
  'from', 'with', 'this', 'that', 'have', 'will', 'been', 'they', 'them', 'then',
  'than', 'what', 'when', 'where', 'which', 'their', 'there', 'these', 'those',
  'about', 'would', 'could', 'should', 'after', 'before', 'being', 'other',
  'active', 'advance', 'signals', 'completion', 'work', 'next', 'step', 'current',
  'recent', 'new', 'now', 'just', 'keep', 'also', 'into', 'more', 'most', 'some',
])

function tokenize(value: string | null | undefined): string[] {
  return normalizeText(value).split(' ').filter(token => token.length > 2 && !STOPWORDS.has(token))
}

function scoreTextOverlap(haystack: string, needles: string[]): number {
  if (needles.length === 0) return 0
  const normalizedHaystack = normalizeText(haystack)
  let score = 0

  for (const needle of needles) {
    if (!needle) continue
    if (normalizedHaystack.includes(needle)) {
      score += needle.split(' ').length > 1 ? 3 : 2
    }
  }

  return score
}

function matchesInitiativeText(initiative: InitiativeRecord, candidateText: string): boolean {
  // Use stable identity fields for matching.
  // Deliberately exclude latestSummary to avoid feedback loops where
  // a wrong artifact pollutes the summary, which then matches more wrong artifacts.
  // goal is safe because stopwords filter out generic terms like "active", "signals", etc.
  const initiativeTokens = tokenize([
    initiative.title,
    initiative.goal,
    initiative.scope,
    ...initiative.stakeholders,
  ].join(' '))

  return scoreTextOverlap(candidateText, initiativeTokens) > 0
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))))
}

function uniquePreserve(existing: string[], updates?: string[] | null): string[] {
  return unique([...(existing ?? []), ...(updates ?? [])])
}

export function deriveInitiativePhase(input: {
  activeCommitmentCount: number
  blockedCommitmentCount: number
  hasRecentSignal: boolean
  hasSuccessCriteria: boolean
  openQuestionCount: number
  previousPhase?: InitiativePhase | null
}): InitiativePhase {
  if (input.blockedCommitmentCount > 0) return 'waiting'
  if (input.activeCommitmentCount > 0) return 'execution'
  if (input.hasSuccessCriteria && input.openQuestionCount === 0 && input.previousPhase === 'execution') {
    return 'verification'
  }
  if (input.hasSuccessCriteria && input.hasRecentSignal) return 'planning'
  if (input.openQuestionCount > 0) return 'alignment'
  return input.previousPhase ?? 'discovery'
}

export function selectRelevantInitiatives(input: RelevantInitiativesInput): InitiativeRecord[] {
  const signalTokens = Array.from(new Set(input.signalTexts.flatMap(text => tokenize(text))))
  const focusTokens = Array.from(new Set((input.focusTopics ?? []).flatMap(topic => tokenize(topic))))
  const nowMs = new Date(input.now).getTime()
  const limit = input.limit ?? 8

  return [...input.initiatives]
    .map(initiative => {
      // Use stable identity fields only — exclude latestSummary/currentHypothesis
      // to prevent feedback loops where wrong data perpetuates wrong matches.
      const searchable = [
        initiative.title,
        initiative.goal,
        initiative.scope,
        initiative.nextMilestone,
        ...initiative.stakeholders,
      ].join(' ')

      const signalScore = scoreTextOverlap(searchable, signalTokens)
      const focusScore = scoreTextOverlap(searchable, focusTokens)
      const reviewScore = initiative.nextReviewAt && new Date(initiative.nextReviewAt).getTime() <= nowMs ? 5 : 0
      const freshnessScore = initiative.lastSignalAt
        ? Math.max(0, 4 - Math.floor((nowMs - new Date(initiative.lastSignalAt).getTime()) / 86_400_000))
        : 0
      const statusScore = initiative.status === 'active' ? 2 : initiative.status === 'blocked' ? 1 : 0
      const totalScore = signalScore * 3 + focusScore * 2 + reviewScore + freshnessScore + statusScore

      return { initiative, totalScore }
    })
    .filter(entry => entry.totalScore > 0)
    .sort((left, right) => right.totalScore - left.totalScore)
    .slice(0, limit)
    .map(entry => entry.initiative)
}

export function buildFocusInitiativeDrafts(input: {
  now: string
  focusProfile: ChiefFocusProfile
  existingInitiatives: InitiativeRecord[]
  activeOutcomes: MinimalOutcome[]
  recentArtifacts: MinimalArtifact[]
  topEntities: MinimalEntity[]
}): InitiativeDraft[] {
  if (!input.focusProfile.isActive || input.focusProfile.priorityTopics.length === 0) {
    return []
  }

  const existingTitles = new Set(input.existingInitiatives.map(initiative => normalizeText(initiative.title)))

  return input.focusProfile.priorityTopics
    .filter(topic => topic.trim().length > 0)
    .filter(topic => !existingTitles.has(normalizeText(topic)))
    .map(topic => {
      const topicTokens = tokenize(topic)
      const matchedOutcomes = input.activeOutcomes.filter(outcome =>
        scoreTextOverlap(`${outcome.title} ${outcome.description ?? ''}`, topicTokens) > 0
      )
      const matchedArtifacts = input.recentArtifacts.filter(artifact =>
        scoreTextOverlap(artifact.title, topicTokens) > 0
      )
      const linkedEntities = input.topEntities.filter(entity =>
        scoreTextOverlap(`${entity.name} ${entity.entityType}`, topicTokens) > 0
      )

      const latestSummaryParts = [
        matchedArtifacts[0] ? `Recent ${matchedArtifacts[0].channel} activity: ${matchedArtifacts[0].title}.` : null,
        matchedOutcomes[0] ? `Active work: ${matchedOutcomes[0].title}.` : null,
        input.focusProfile.instructions ? `Focus guidance: ${input.focusProfile.instructions}` : null,
      ].filter(Boolean)

      return {
        title: topic,
        goal: `Advance ${topic} from active signals to completion.`,
        scope: matchedArtifacts[0]?.title ?? matchedOutcomes[0]?.description ?? null,
        status: 'active' as const,
        phase: deriveInitiativePhase({
          activeCommitmentCount: matchedOutcomes.length,
          blockedCommitmentCount: 0,
          hasRecentSignal: matchedArtifacts.length > 0 || matchedOutcomes.length > 0,
          hasSuccessCriteria: true,
          openQuestionCount: 0,
          previousPhase: null,
        }),
        successCriteria: ['Key stakeholder alignment', 'Next milestone completed'],
        currentHypothesis: matchedArtifacts[0]
          ? `${topic} is moving because of recent ${matchedArtifacts[0].channel} activity.`
          : null,
        openQuestions: [],
        knownRisks: [],
        dependencies: [],
        stakeholders: linkedEntities.map(entity => entity.name),
        linkedEntityIds: linkedEntities.map(entity => entity.id),
        latestSummary: latestSummaryParts.join(' ').trim() || `Focused work stream for ${topic}.`,
        nextMilestone: matchedOutcomes[0]?.title ?? matchedArtifacts[0]?.title ?? null,
        nextReviewAt: new Date(new Date(input.now).getTime() + 4 * 60 * 60 * 1000).toISOString(),
        lastSignalAt: matchedArtifacts[0]?.startedAt ?? null,
        source: 'chief_loop' as const,
      }
    })
}

export function reconcileInitiativeState(input: {
  now: string
  initiative: InitiativeRecord
  activeClaims: MinimalClaim[]
  activeCommitments: MinimalCommitment[]
  decisionThreads: MinimalDecisionThread[]
  activeNarratives: MinimalNarrative[]
  recentArtifacts: MinimalArtifact[]
}): InitiativeRecord {
  const matchingClaims = input.activeClaims.filter(claim =>
    matchesInitiativeText(input.initiative, `${claim.predicate} ${claim.objectValue ?? ''}`)
  )
  const matchingCommitments = input.activeCommitments.filter(commitment =>
    matchesInitiativeText(input.initiative, `${commitment.title} ${commitment.status} ${commitment.priority}`)
  )
  const matchingDecisionThreads = input.decisionThreads.filter(thread =>
    matchesInitiativeText(input.initiative, `${thread.title} ${thread.status}`)
  )
  const matchingNarratives = input.activeNarratives.filter(narrative =>
    matchesInitiativeText(input.initiative, `${narrative.title} ${narrative.summary}`)
  )
  const matchingArtifacts = input.recentArtifacts.filter(artifact =>
    matchesInitiativeText(input.initiative, `${artifact.title} ${artifact.channel}`)
  )

  const commitmentRiskLines = matchingCommitments
    .filter(commitment => ['at_risk', 'overdue'].includes(commitment.status))
    .map(commitment => `${commitment.title} is ${commitment.status.replace(/_/g, ' ')}.`)

  const openQuestions = [
    ...input.initiative.openQuestions,
    ...matchingDecisionThreads
      .filter(thread => thread.status === 'open')
      .map(thread => `Resolve decision thread: ${thread.title}`),
  ]

  const knownRisks = [
    ...input.initiative.knownRisks,
    ...commitmentRiskLines,
  ]

  const latestSummary = [
    matchingNarratives[0]?.summary,
    matchingArtifacts[0] ? `Recent ${matchingArtifacts[0].channel} activity: ${matchingArtifacts[0].title}.` : null,
    matchingCommitments[0] ? `Current work: ${matchingCommitments[0].title} [${matchingCommitments[0].status}].` : null,
  ].filter(Boolean).join(' ').trim() || input.initiative.latestSummary

  const status: InitiativeStatus =
    matchingCommitments.some(commitment => commitment.status === 'overdue') ? 'blocked'
    : matchingCommitments.some(commitment => commitment.status === 'at_risk') ? 'waiting'
    : input.initiative.status

  const phase = deriveInitiativePhase({
    activeCommitmentCount: matchingCommitments.filter(commitment => commitment.status === 'active').length,
    blockedCommitmentCount: matchingCommitments.filter(commitment => ['at_risk', 'overdue'].includes(commitment.status)).length,
    hasRecentSignal: matchingArtifacts.length > 0 || matchingClaims.length > 0,
    hasSuccessCriteria: input.initiative.successCriteria.length > 0,
    openQuestionCount: unique(openQuestions).length,
    previousPhase: input.initiative.phase,
  })

  return {
    ...input.initiative,
    status,
    phase,
    linkedClaimIds: unique([...input.initiative.linkedClaimIds, ...matchingClaims.map(claim => claim.id)]),
    linkedCommitmentIds: unique([...input.initiative.linkedCommitmentIds, ...matchingCommitments.map(commitment => commitment.id)]),
    linkedDecisionThreadIds: unique([...input.initiative.linkedDecisionThreadIds, ...matchingDecisionThreads.map(thread => thread.id)]),
    openQuestions: unique(openQuestions).slice(0, 6),
    knownRisks: unique(knownRisks).slice(0, 6),
    latestSummary: latestSummary ?? null,
    nextMilestone: matchingCommitments[0]?.title ?? input.initiative.nextMilestone,
    lastSignalAt: matchingArtifacts[0]?.startedAt ?? matchingClaims[0]?.updatedAt ?? input.initiative.lastSignalAt,
    lastReconciledAt: input.now,
    nextReviewAt: new Date(new Date(input.now).getTime() + (status === 'blocked' ? 2 : 6) * 60 * 60 * 1000).toISOString(),
  }
}

export function deriveInitiativeArtifactLinks(input: {
  initiatives: InitiativeRecord[]
  activeClaims: MinimalClaim[]
  recentArtifacts: MinimalArtifact[]
}): InitiativeArtifactLink[] {
  const links = new Map<string, InitiativeArtifactLink>()

  for (const initiative of input.initiatives) {
    const claimArtifactIds = new Set(
      input.activeClaims
        .filter((claim) =>
          initiative.linkedClaimIds.includes(claim.id)
          || matchesInitiativeText(initiative, `${claim.predicate} ${claim.objectValue ?? ''}`)
        )
        .map((claim) => claim.artifactId)
        .filter((artifactId): artifactId is string => Boolean(artifactId))
    )

    const signalArtifactIds = new Set(
      input.recentArtifacts
        .filter((artifact) => matchesInitiativeText(initiative, `${artifact.title} ${artifact.channel}`))
        .map((artifact) => artifact.id)
        .filter((artifactId): artifactId is string => Boolean(artifactId))
    )

    const artifactIds = new Set([...claimArtifactIds, ...signalArtifactIds])
    for (const artifactId of artifactIds) {
      const key = `${initiative.id}:${artifactId}`
      const hasClaim = claimArtifactIds.has(artifactId)
      const hasSignal = signalArtifactIds.has(artifactId)
      links.set(key, {
        initiativeId: initiative.id,
        artifactId,
        linkReason: hasClaim && hasSignal ? 'claim+signal' : hasClaim ? 'claim' : 'signal',
      })
    }
  }

  return [...links.values()].sort((left, right) => {
    if (left.initiativeId !== right.initiativeId) {
      return left.initiativeId.localeCompare(right.initiativeId)
    }
    return left.artifactId.localeCompare(right.artifactId)
  })
}

export function materializeInitiativeDecision(input: {
  now: string
  orgId: string
  decision: InitiativeDecisionInput
  existing?: InitiativeRecord | null
}): InitiativeRecord {
  const nextReviewAt = input.decision.nextReviewAt
    ?? input.existing?.nextReviewAt
    ?? new Date(new Date(input.now).getTime() + 6 * 60 * 60 * 1000).toISOString()

  const base: InitiativeRecord = input.existing ?? {
    id: crypto.randomUUID(),
    orgId: input.orgId,
    title: input.decision.title,
    goal: input.decision.goal?.trim() || `Advance ${input.decision.title} to completion.`,
    scope: input.decision.scope ?? null,
    status: input.decision.status ?? 'active',
    phase: input.decision.phase ?? 'discovery',
    successCriteria: unique(input.decision.successCriteria ?? []),
    currentHypothesis: input.decision.currentHypothesis ?? null,
    openQuestions: unique(input.decision.openQuestions ?? []),
    knownRisks: unique(input.decision.knownRisks ?? []),
    dependencies: unique(input.decision.dependencies ?? []),
    stakeholders: unique(input.decision.stakeholders ?? []),
    linkedEntityIds: unique(input.decision.linkedEntityIds ?? []),
    linkedClaimIds: unique(input.decision.linkedClaimIds ?? []),
    linkedCommitmentIds: unique(input.decision.linkedCommitmentIds ?? []),
    linkedDecisionThreadIds: unique(input.decision.linkedDecisionThreadIds ?? []),
    latestSummary: input.decision.latestSummary ?? null,
    nextMilestone: input.decision.nextMilestone ?? null,
    nextReviewAt,
    lastSignalAt: input.decision.lastSignalAt ?? input.now,
    lastReconciledAt: input.now,
    source: input.decision.source ?? 'chief_loop',
    updatedAt: null,
  }

  return {
    ...base,
    title: input.decision.title || base.title,
    goal: input.decision.goal?.trim() || base.goal,
    scope: input.decision.scope !== undefined ? input.decision.scope : base.scope,
    status: input.decision.status ?? base.status,
    phase: input.decision.phase ?? base.phase,
    successCriteria: input.decision.successCriteria ? uniquePreserve(base.successCriteria, input.decision.successCriteria) : base.successCriteria,
    currentHypothesis: input.decision.currentHypothesis !== undefined ? input.decision.currentHypothesis : base.currentHypothesis,
    openQuestions: input.decision.openQuestions ? uniquePreserve(base.openQuestions, input.decision.openQuestions).slice(0, 8) : base.openQuestions,
    knownRisks: input.decision.knownRisks ? uniquePreserve(base.knownRisks, input.decision.knownRisks).slice(0, 8) : base.knownRisks,
    dependencies: input.decision.dependencies ? uniquePreserve(base.dependencies, input.decision.dependencies) : base.dependencies,
    stakeholders: input.decision.stakeholders ? uniquePreserve(base.stakeholders, input.decision.stakeholders) : base.stakeholders,
    linkedEntityIds: input.decision.linkedEntityIds ? uniquePreserve(base.linkedEntityIds, input.decision.linkedEntityIds) : base.linkedEntityIds,
    linkedClaimIds: input.decision.linkedClaimIds ? uniquePreserve(base.linkedClaimIds, input.decision.linkedClaimIds) : base.linkedClaimIds,
    linkedCommitmentIds: input.decision.linkedCommitmentIds ? uniquePreserve(base.linkedCommitmentIds, input.decision.linkedCommitmentIds) : base.linkedCommitmentIds,
    linkedDecisionThreadIds: input.decision.linkedDecisionThreadIds ? uniquePreserve(base.linkedDecisionThreadIds, input.decision.linkedDecisionThreadIds) : base.linkedDecisionThreadIds,
    latestSummary: input.decision.latestSummary !== undefined ? input.decision.latestSummary : base.latestSummary,
    nextMilestone: input.decision.nextMilestone !== undefined ? input.decision.nextMilestone : base.nextMilestone,
    nextReviewAt,
    lastSignalAt: input.decision.lastSignalAt ?? base.lastSignalAt ?? input.now,
    lastReconciledAt: input.now,
    source: input.decision.source ?? base.source ?? 'chief_loop',
  }
}

function buildInitiativeFingerprint(initiative: InitiativeRecord): string {
  return JSON.stringify({
    title: initiative.title,
    goal: initiative.goal,
    scope: initiative.scope,
    status: initiative.status,
    phase: initiative.phase,
    successCriteria: initiative.successCriteria,
    currentHypothesis: initiative.currentHypothesis,
    openQuestions: initiative.openQuestions,
    knownRisks: initiative.knownRisks,
    dependencies: initiative.dependencies,
    stakeholders: initiative.stakeholders,
    linkedEntityIds: initiative.linkedEntityIds,
    linkedClaimIds: initiative.linkedClaimIds,
    linkedCommitmentIds: initiative.linkedCommitmentIds,
    linkedDecisionThreadIds: initiative.linkedDecisionThreadIds,
    latestSummary: initiative.latestSummary,
    nextMilestone: initiative.nextMilestone,
    nextReviewAt: initiative.nextReviewAt,
    lastSignalAt: initiative.lastSignalAt,
    source: initiative.source,
  })
}

export function selectChangedInitiatives(input: {
  previous: InitiativeRecord[]
  next: InitiativeRecord[]
}): string[] {
  const previousById = new Map(input.previous.map(initiative => [initiative.id, initiative]))
  const changedIds: string[] = []

  for (const initiative of input.next) {
    const previous = previousById.get(initiative.id)
    if (!previous) {
      changedIds.push(initiative.id)
      continue
    }

    if (buildInitiativeFingerprint(previous) !== buildInitiativeFingerprint(initiative)) {
      changedIds.push(initiative.id)
    }
  }

  return changedIds
}

export function findInitiativeRelatedDocuments(input: {
  initiative: InitiativeRecord
  documents: IntelligenceVaultEntryPoint[]
  limit?: number
}): IntelligenceVaultEntryPoint[] {
  const limit = input.limit ?? 6

  return input.documents
    .filter(document => matchesInitiativeText(input.initiative, `${document.title} ${document.path}`))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit)
}
