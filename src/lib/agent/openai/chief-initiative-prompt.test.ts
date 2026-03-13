import { describe, expect, it } from 'vitest'

import type { ChiefAnalystInput } from '@/lib/agent/openai/chief-analyst-agent'
import {
  buildInitiativePlannerPrompt,
  shouldRunInitiativePlanner,
  type TriageClassification,
} from '@/lib/agent/openai/chief-sub-agents'

function buildInput(): ChiefAnalystInput {
  return {
    orgId: 'org-1',
    orgName: 'KeyValue Systems',
    currentTime: '2026-03-13T08:00:00.000Z',
    timezone: 'Asia/Kolkata',
    activeOutcomes: [],
    recentEmails: [],
    recentSlackMessages: [],
    todayEvents: [],
    recentInsights: [],
    recentFindings: [],
    topEntities: [],
    recentRelationships: [],
    recentMemories: [],
    activeClaims: [],
    activeCommitments: [
      {
        id: 'commitment-1',
        title: 'Send Crane estimate',
        status: 'at_risk',
        priority: 'high',
        dueDate: '2026-03-14',
        updatedAt: '2026-03-13T07:30:00.000Z',
        linkedEntityIds: ['entity-crane'],
      },
    ],
    decisionThreads: [
      {
        id: 'decision-1',
        title: 'Crane pricing approach',
        status: 'open',
        relatedEntityIds: ['entity-crane'],
        updatedAt: '2026-03-13T07:40:00.000Z',
      },
    ],
    activeNarratives: [
      {
        id: 'narrative-1',
        title: 'Crane <> KeyValue',
        narrativeType: 'relationship',
        summary: 'Crane is evaluating the estimate and workflow fit.',
        relatedEntityIds: ['entity-crane'],
        updatedAt: '2026-03-13T07:45:00.000Z',
      },
    ],
    recentSourceArtifacts: [
      {
        id: 'artifact-1',
        title: 'Crane <> KeyValue',
        channel: 'meeting',
        startedAt: '2026-03-13T06:00:00.000Z',
        endedAt: '2026-03-13T06:45:00.000Z',
        updatedAt: '2026-03-13T07:50:00.000Z',
      },
    ],
    vaultContext: [
      {
        id: 'doc-1',
        path: 'Narratives/Relationships/crane-keyvalue.md',
        title: 'Crane <> KeyValue',
        documentType: 'narrative',
        summary: 'The relationship is active but needs a cleaner estimation package.',
        manualSectionSummaries: ['Muhammadali wants this to stay top priority.'],
        updatedAt: '2026-03-13T07:55:00.000Z',
      },
    ],
    activeInitiatives: [
      {
        id: 'initiative-1',
        orgId: 'org-1',
        title: 'Crane estimation',
        goal: 'Advance the Crane estimation to close scoping.',
        scope: null,
        status: 'active',
        phase: 'planning',
        successCriteria: ['Estimate sent'],
        currentHypothesis: 'A revised estimate will unblock the next meeting.',
        openQuestions: ['Does Crane want fixed bid or T&M?'],
        knownRisks: ['Estimate package still feels incomplete.'],
        dependencies: [],
        stakeholders: ['Crane Ventures'],
        linkedEntityIds: ['entity-crane'],
        linkedClaimIds: [],
        linkedCommitmentIds: ['commitment-1'],
        linkedDecisionThreadIds: ['decision-1'],
        latestSummary: 'Crane is waiting on a tighter estimate.',
        nextMilestone: 'Send revised estimate',
        nextReviewAt: '2026-03-13T08:30:00.000Z',
        lastSignalAt: '2026-03-13T07:45:00.000Z',
        lastReconciledAt: '2026-03-13T07:30:00.000Z',
        source: 'chief_loop',
      },
    ],
    chiefWorldModel: {
      operationalMemory: {
        urgentCommitments: [],
        staleDecisions: [],
        blockedInitiatives: [
          {
            initiativeId: 'initiative-1',
            title: 'Crane estimation',
            reason: 'Estimate package still feels incomplete.',
          },
        ],
      },
      narrativeMemory: [],
      executionMemory: [
        {
          initiativeId: 'initiative-1',
          title: 'Crane estimation',
          phase: 'planning',
          status: 'active',
          nextMilestone: 'Send revised estimate',
          nextReviewAt: '2026-03-13T08:30:00.000Z',
          latestSummary: 'Crane is waiting on a tighter estimate.',
        },
      ],
      initiativePriorities: [],
      changedSinceLastRun: {
        artifacts: [
          { id: 'artifact-1', title: 'Crane <> KeyValue', channel: 'meeting' },
        ],
        updatedInitiativeIds: ['initiative-1'],
      },
      version: 2,
    },
    workerViews: {
      cole: {
        activeCount: 0,
        atRiskCount: 0,
        overdueCount: 0,
        completedTodayCount: 0,
        topDeadlines: [],
        pendingActionsCount: 0,
        oldestActionDays: null,
      },
      rhea: {
        hasVantaConnection: false,
        failingControlsCount: 0,
        topFailingControls: [],
        complianceFindings: 0,
      },
      eve: {
        recentDecisions: [],
        keyStakeholders: [],
      },
      patrol: {
        openFindingsCount: 0,
        criticalFindings: 0,
        byType: {},
        newSinceYesterday: 0,
      },
      outcomes: {
        active: [],
        totalActive: 0,
      },
      insights: {
        contradictions: [],
        patterns: [],
        anomalies: [],
        staleItems: [],
        risks: [],
        totalActive: 0,
      },
    } as ChiefAnalystInput['workerViews'],
    connectedIntegrations: [],
    focusProfile: {
      isActive: true,
      priorityTopics: ['Crane Ventures'],
      deprioritizedTopics: ['Axari'],
      instructions: 'Prioritize active client work.',
    },
  }
}

describe('buildInitiativePlannerPrompt', () => {
  it('includes active initiatives, world model, and vault manual context', () => {
    const prompt = buildInitiativePlannerPrompt(buildInput(), [
      {
        signalId: 'artifact-1',
        signalType: 'email',
        category: 'needs_action',
        priority: 'high',
        reasoning: 'Estimate needs follow-up.',
      },
    ])

    expect(prompt).toContain('ACTIVE INITIATIVES')
    expect(prompt).toContain('Crane estimation (initiative-1)')
    expect(prompt).toContain('WORLD MODEL')
    expect(prompt).toContain('Blocked: Crane estimation')
    expect(prompt).toContain('VAULT CONTEXT')
    expect(prompt).toContain('manual: Muhammadali wants this to stay top priority.')
  })
})

describe('shouldRunInitiativePlanner', () => {
  const noSignals: TriageClassification[] = []

  it('runs when an initiative is due for review even without new signals', () => {
    const shouldRun = shouldRunInitiativePlanner(
      buildInput(),
      noSignals,
      '2026-03-13T09:00:00.000Z'
    )

    expect(shouldRun).toBe(true)
  })

  it('runs when there are durable signals even if no review is due', () => {
    const input = buildInput()
    input.activeInitiatives[0].nextReviewAt = '2026-03-14T09:00:00.000Z'

    const shouldRun = shouldRunInitiativePlanner(
      input,
      [
        {
          signalId: 'artifact-1',
          signalType: 'slack',
          category: 'needs_analysis',
          priority: 'medium',
          reasoning: 'The scope may have changed.',
        },
      ],
      '2026-03-13T08:00:00.000Z'
    )

    expect(shouldRun).toBe(true)
  })
})
