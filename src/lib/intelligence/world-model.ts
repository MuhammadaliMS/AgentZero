import type { InitiativeRecord } from '@/lib/intelligence/initiative-state'

interface MinimalCommitment {
  id: string
  title: string
  status: string
  dueDate?: string | null
}

interface MinimalDecisionThread {
  id: string
  title: string
  status: string
}

interface MinimalNarrative {
  id: string
  title: string
  summary: string
}

interface MinimalArtifact {
  id: string
  title: string
  channel: string
}

export interface ChiefWorldModelRecord {
  operationalMemory: {
    urgentCommitments: MinimalCommitment[]
    staleDecisions: MinimalDecisionThread[]
    blockedInitiatives: Array<{ initiativeId: string; title: string; reason: string }>
  }
  narrativeMemory: MinimalNarrative[]
  executionMemory: Array<{
    initiativeId: string
    title: string
    phase: InitiativeRecord['phase']
    status: InitiativeRecord['status']
    nextMilestone: string | null
    nextReviewAt: string | null
    latestSummary: string | null
  }>
  initiativePriorities: Array<{
    initiativeId: string
    title: string
    priorityScore: number
  }>
  changedSinceLastRun: {
    artifacts: MinimalArtifact[]
    updatedInitiativeIds: string[]
  }
  version: number
}

export function buildChiefWorldModel(input: {
  now: string
  initiatives: InitiativeRecord[]
  activeCommitments: MinimalCommitment[]
  decisionThreads: MinimalDecisionThread[]
  activeNarratives: MinimalNarrative[]
  changedArtifacts: MinimalArtifact[]
  updatedInitiativeIds?: string[]
  previous: ChiefWorldModelRecord | null
}): ChiefWorldModelRecord {
  const nowMs = new Date(input.now).getTime()

  const urgentCommitments = input.activeCommitments.filter(commitment =>
    ['at_risk', 'overdue'].includes(commitment.status)
  )

  const staleDecisions = input.decisionThreads.filter(thread => thread.status === 'open').slice(0, 10)

  const blockedInitiatives = input.initiatives
    .filter(initiative => initiative.status === 'blocked' || initiative.phase === 'waiting')
    .map(initiative => ({
      initiativeId: initiative.id,
      title: initiative.title,
      reason: initiative.knownRisks[0] ?? initiative.openQuestions[0] ?? 'Waiting on external progress.',
    }))

  const executionMemory = input.initiatives.map(initiative => ({
    initiativeId: initiative.id,
    title: initiative.title,
    phase: initiative.phase,
    status: initiative.status,
    nextMilestone: initiative.nextMilestone,
    nextReviewAt: initiative.nextReviewAt,
    latestSummary: initiative.latestSummary,
  }))

  const initiativePriorities = input.initiatives
    .map(initiative => {
      const reviewScore = initiative.nextReviewAt && new Date(initiative.nextReviewAt).getTime() <= nowMs ? 5 : 0
      const activeScore = initiative.status === 'active' ? 3 : initiative.status === 'blocked' ? 2 : 0
      const commitmentScore = initiative.linkedCommitmentIds.length * 2
      const signalScore = initiative.lastSignalAt ? 2 : 0

      return {
        initiativeId: initiative.id,
        title: initiative.title,
        priorityScore: reviewScore + activeScore + commitmentScore + signalScore,
      }
    })
    .sort((left, right) => right.priorityScore - left.priorityScore)

  return {
    operationalMemory: {
      urgentCommitments,
      staleDecisions,
      blockedInitiatives,
    },
    narrativeMemory: input.activeNarratives.slice(0, 12),
    executionMemory,
    initiativePriorities,
    changedSinceLastRun: {
      artifacts: input.changedArtifacts,
      updatedInitiativeIds: input.updatedInitiativeIds ?? input.initiatives.map(initiative => initiative.id),
    },
    version: (input.previous?.version ?? 0) + 1,
  }
}
