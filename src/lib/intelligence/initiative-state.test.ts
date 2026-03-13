import { describe, expect, it } from 'vitest'

import {
  buildFocusInitiativeDrafts,
  deriveInitiativePhase,
  findInitiativeRelatedDocuments,
  reconcileInitiativeState,
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

describe('reconcileInitiativeState', () => {
  it('links matching work objects and refreshes summary, risks, and phase', () => {
    const reconciled = reconcileInitiativeState({
      now: '2026-03-13T07:00:00.000Z',
      initiative: {
        id: 'initiative-1',
        orgId: 'org-1',
        title: 'Crane estimation',
        goal: 'Advance Crane estimation work',
        scope: null,
        status: 'active',
        phase: 'planning',
        successCriteria: ['Estimate sent'],
        currentHypothesis: null,
        openQuestions: [],
        knownRisks: [],
        dependencies: [],
        stakeholders: [],
        linkedEntityIds: [],
        linkedClaimIds: [],
        linkedCommitmentIds: [],
        linkedDecisionThreadIds: [],
        latestSummary: null,
        nextMilestone: null,
        nextReviewAt: null,
        lastSignalAt: null,
        lastReconciledAt: null,
        source: 'chief_loop',
        updatedAt: null,
      },
      activeClaims: [
        {
          id: 'claim-1',
          predicate: 'works_on',
          objectValue: 'Crane estimate',
          updatedAt: '2026-03-13T06:20:00.000Z',
        },
      ],
      activeCommitments: [
        {
          id: 'commitment-1',
          title: 'Send Crane estimate',
          status: 'at_risk',
          priority: 'high',
          dueDate: '2026-03-14',
          updatedAt: '2026-03-13T06:30:00.000Z',
        },
      ],
      decisionThreads: [
        {
          id: 'decision-1',
          title: 'Crane pricing approach',
          status: 'open',
          updatedAt: '2026-03-13T06:40:00.000Z',
        },
      ],
      activeNarratives: [
        {
          id: 'narrative-1',
          title: 'Crane <> KeyValue',
          summary: 'Crane is pushing toward an estimate and scoping package.',
          updatedAt: '2026-03-13T06:50:00.000Z',
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
    })

    expect(reconciled.linkedClaimIds).toEqual(['claim-1'])
    expect(reconciled.linkedCommitmentIds).toEqual(['commitment-1'])
    expect(reconciled.linkedDecisionThreadIds).toEqual(['decision-1'])
    expect(reconciled.knownRisks[0]).toContain('Send Crane estimate')
    expect(reconciled.openQuestions[0]).toContain('Crane pricing approach')
    expect(reconciled.phase).toBe('waiting')
    expect(reconciled.latestSummary).toContain('Crane')
  })
})

describe('findInitiativeRelatedDocuments', () => {
  it('returns initiative-relevant docs in freshness order', () => {
    const related = findInitiativeRelatedDocuments({
      initiative: {
        id: 'initiative-1',
        orgId: 'org-1',
        title: 'Crane estimation',
        goal: 'Advance Crane estimation work',
        scope: null,
        status: 'active',
        phase: 'execution',
        successCriteria: [],
        currentHypothesis: null,
        openQuestions: [],
        knownRisks: [],
        dependencies: [],
        stakeholders: [],
        linkedEntityIds: [],
        linkedClaimIds: [],
        linkedCommitmentIds: [],
        linkedDecisionThreadIds: [],
        latestSummary: null,
        nextMilestone: null,
        nextReviewAt: null,
        lastSignalAt: null,
        lastReconciledAt: null,
        source: 'chief_loop',
        updatedAt: null,
      },
      documents: [
        {
          path: 'Narratives/Accounts/crane-ventures.md',
          title: 'Crane Ventures',
          documentType: 'narrative',
          updatedAt: '2026-03-13T06:50:00.000Z',
          lastSourceUpdateAt: null,
        },
        {
          path: 'Knowledge/Organizations/axari.md',
          title: 'Axari',
          documentType: 'entity',
          updatedAt: '2026-03-13T06:30:00.000Z',
          lastSourceUpdateAt: null,
        },
      ],
    })

    expect(related).toHaveLength(1)
    expect(related[0]?.title).toBe('Crane Ventures')
  })
})
