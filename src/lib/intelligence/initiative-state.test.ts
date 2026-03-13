import { describe, expect, it } from 'vitest'

import {
  buildFocusInitiativeDrafts,
  deriveInitiativePhase,
  selectRelevantInitiatives,
  type InitiativeRecord,
} from '@/lib/intelligence/initiative-state'
import { extractChiefFocusProfile } from '@/lib/intelligence/focus-profile'

describe('deriveInitiativePhase', () => {
  it('moves focused work with active commitments into execution', () => {
    const phase = deriveInitiativePhase({
      activeCommitmentCount: 2,
      blockedCommitmentCount: 0,
      hasRecentSignal: true,
      hasSuccessCriteria: true,
      openQuestionCount: 1,
      previousPhase: 'planning',
    })

    expect(phase).toBe('execution')
  })

  it('keeps blocked work in waiting', () => {
    const phase = deriveInitiativePhase({
      activeCommitmentCount: 0,
      blockedCommitmentCount: 1,
      hasRecentSignal: true,
      hasSuccessCriteria: true,
      openQuestionCount: 0,
      previousPhase: 'execution',
    })

    expect(phase).toBe('waiting')
  })
})

describe('selectRelevantInitiatives', () => {
  const now = '2026-03-13T07:00:00.000Z'
  const initiatives: InitiativeRecord[] = [
    {
      id: '1',
      orgId: 'org-1',
      title: 'Crane Ventures estimation',
      goal: 'Advance the Crane estimation and scoping effort',
      scope: null,
      status: 'active',
      phase: 'execution',
      successCriteria: [],
      currentHypothesis: null,
      openQuestions: [],
      knownRisks: [],
      dependencies: [],
      stakeholders: ['Crane'],
      linkedEntityIds: ['entity-crane'],
      linkedClaimIds: [],
      linkedCommitmentIds: [],
      linkedDecisionThreadIds: [],
      latestSummary: 'Crane scoping is active',
      nextMilestone: 'Send estimate',
      nextReviewAt: '2026-03-13T08:00:00.000Z',
      lastSignalAt: '2026-03-13T06:30:00.000Z',
      lastReconciledAt: '2026-03-13T06:45:00.000Z',
      source: 'chief_loop',
      updatedAt: '2026-03-13T06:45:00.000Z',
    },
    {
      id: '2',
      orgId: 'org-1',
      title: 'Axari internal platform',
      goal: 'Ship Axari product changes',
      scope: null,
      status: 'active',
      phase: 'planning',
      successCriteria: [],
      currentHypothesis: null,
      openQuestions: [],
      knownRisks: [],
      dependencies: [],
      stakeholders: ['Axari'],
      linkedEntityIds: ['entity-axari'],
      linkedClaimIds: [],
      linkedCommitmentIds: [],
      linkedDecisionThreadIds: [],
      latestSummary: 'Background internal product work',
      nextMilestone: 'Spec review',
      nextReviewAt: '2026-03-20T08:00:00.000Z',
      lastSignalAt: '2026-03-10T06:30:00.000Z',
      lastReconciledAt: '2026-03-10T06:45:00.000Z',
      source: 'chief_loop',
      updatedAt: '2026-03-10T06:45:00.000Z',
    },
  ]

  it('prioritizes initiatives that match fresh signals and are due for review', () => {
    const selected = selectRelevantInitiatives({
      initiatives,
      now,
      limit: 1,
      focusTopics: ['Crane'],
      signalTexts: [
        'Need to finish the Crane estimate and follow up on the scoping call.',
      ],
    })

    expect(selected.map(item => item.id)).toEqual(['1'])
  })
})

describe('buildFocusInitiativeDrafts', () => {
  it('seeds initiatives from current chief focus and related signals', () => {
    const focusProfile = extractChiefFocusProfile({
      chief_focus_topics: ['Crane Ventures', 'KeyValue estimation'],
      chief_focus_instructions: 'Prioritize active client work over internal product chatter.',
    })

    const drafts = buildFocusInitiativeDrafts({
      now: '2026-03-13T07:00:00.000Z',
      focusProfile,
      existingInitiatives: [],
      activeOutcomes: [
        {
          id: 'outcome-1',
          title: 'Send Crane estimation package',
          description: 'Finalize estimate and scoping details for Crane',
          status: 'executing',
          priority: 'high',
          createdAt: '2026-03-13T06:00:00.000Z',
          updatedAt: '2026-03-13T06:30:00.000Z',
          runId: 'run-1',
          steps: [],
        },
      ],
      recentArtifacts: [
        {
          id: 'artifact-1',
          title: 'Crane <> KeyValue',
          channel: 'meeting',
          startedAt: '2026-03-13T05:00:00.000Z',
        },
      ],
      topEntities: [
        { id: 'entity-crane', name: 'Crane Ventures', entityType: 'vendor' },
      ],
    })

    expect(drafts).toHaveLength(2)
    expect(drafts[0]?.title).toBe('Crane Ventures')
    expect(drafts[0]?.linkedEntityIds).toEqual(['entity-crane'])
    expect(drafts[0]?.latestSummary).toContain('Crane')
  })
})
