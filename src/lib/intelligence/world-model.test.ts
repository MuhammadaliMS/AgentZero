import { describe, expect, it } from 'vitest'

import { buildChiefWorldModel } from '@/lib/intelligence/world-model'
import type { InitiativeRecord } from '@/lib/intelligence/initiative-state'

describe('buildChiefWorldModel', () => {
  it('creates operational, narrative, and execution memory from org state', () => {
    const initiatives: InitiativeRecord[] = [
      {
        id: 'initiative-1',
        orgId: 'org-1',
        title: 'Crane Ventures',
        goal: 'Advance the Crane estimation work',
        scope: null,
        status: 'active',
        phase: 'execution',
        successCriteria: ['Estimate approved'],
        currentHypothesis: 'Crane will move to diligence if estimate lands this week.',
        openQuestions: ['Who owns the rate card?'],
        knownRisks: ['Screen-sharing issue slowed the last meeting'],
        dependencies: [],
        stakeholders: ['Max Chapman'],
        linkedEntityIds: ['entity-crane'],
        linkedClaimIds: ['claim-1'],
        linkedCommitmentIds: ['commitment-1'],
        linkedDecisionThreadIds: ['decision-1'],
        latestSummary: 'Crane estimation is active',
        nextMilestone: 'Share the final estimate',
        nextReviewAt: '2026-03-13T12:00:00.000Z',
        lastSignalAt: '2026-03-13T06:30:00.000Z',
        lastReconciledAt: '2026-03-13T06:45:00.000Z',
        source: 'chief_loop',
        updatedAt: '2026-03-13T06:45:00.000Z',
      },
    ]

    const worldModel = buildChiefWorldModel({
      now: '2026-03-13T07:00:00.000Z',
      initiatives,
      activeCommitments: [
        { id: 'commitment-1', title: 'Send Crane estimate', status: 'at_risk', dueDate: '2026-03-14' },
      ],
      decisionThreads: [
        { id: 'decision-1', title: 'Crane platform choice', status: 'open' },
      ],
      activeNarratives: [
        { id: 'narrative-1', title: 'Crane <> KeyValue', summary: 'Relationship is moving into diligence.' },
      ],
      changedArtifacts: [
        { id: 'artifact-1', title: 'Crane <> KeyValue', channel: 'meeting' },
      ],
      previous: null,
    })

    expect(worldModel.operationalMemory.urgentCommitments).toHaveLength(1)
    expect(worldModel.narrativeMemory[0]?.title).toBe('Crane <> KeyValue')
    expect(worldModel.executionMemory[0]?.phase).toBe('execution')
    expect(worldModel.changedSinceLastRun.artifacts[0]?.title).toBe('Crane <> KeyValue')
    expect(worldModel.initiativePriorities[0]?.initiativeId).toBe('initiative-1')
  })
})
