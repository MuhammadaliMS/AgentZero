import type { ChiefFocusProfile } from '@/lib/intelligence/focus-profile'

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

function tokenize(value: string | null | undefined): string[] {
  return normalizeText(value).split(' ').filter(token => token.length > 2)
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
      const searchable = [
        initiative.title,
        initiative.goal,
        initiative.scope,
        initiative.latestSummary,
        initiative.currentHypothesis,
        initiative.nextMilestone,
        ...initiative.openQuestions,
        ...initiative.knownRisks,
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
