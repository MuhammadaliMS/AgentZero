import { describe, expect, it, vi } from 'vitest'

import {
  finalizeChiefLoopCloseout,
  type ChiefLoopResult,
  type WorkingMemory,
} from '@/lib/intelligence/chief-loop'
import type { ChiefDecision } from '@/lib/agent/openai/chief-analyst-agent'
import type { InitiativeRecord } from '@/lib/intelligence/initiative-state'

function buildInitiative(overrides: Partial<InitiativeRecord> = {}): InitiativeRecord {
  return {
    id: 'initiative-1',
    orgId: 'org-1',
    title: 'Crane estimation',
    goal: 'Advance the Crane estimation to signed scope.',
    scope: null,
    status: 'active',
    phase: 'planning',
    successCriteria: ['Estimate approved'],
    currentHypothesis: 'A revised estimate will unblock diligence.',
    openQuestions: ['Does Crane want fixed bid or T&M?'],
    knownRisks: ['Estimate package is still incomplete.'],
    dependencies: [],
    stakeholders: ['Crane Ventures'],
    linkedEntityIds: ['entity-crane'],
    linkedClaimIds: ['claim-1'],
    linkedCommitmentIds: ['commitment-1'],
    linkedDecisionThreadIds: ['decision-1'],
    latestSummary: 'Crane needs a tighter estimate package.',
    nextMilestone: 'Send revised estimate',
    nextReviewAt: '2026-03-13T12:00:00.000Z',
    lastSignalAt: '2026-03-13T08:00:00.000Z',
    lastReconciledAt: '2026-03-13T08:30:00.000Z',
    source: 'chief_loop',
    updatedAt: '2026-03-13T08:30:00.000Z',
    ...overrides,
  }
}

function buildChiefResult(): ChiefLoopResult {
  return {
    orgId: 'org-1',
    leaseId: 'lease-1',
    signalsGathered: 3,
    replans: 0,
    newOutcomes: 0,
    stepsExecuted: 0,
    blockersEscalated: 0,
    graphUpdates: 0,
    deferredItems: 0,
    costUsd: 0,
    durationMs: 0,
    phases: {},
  }
}

function buildGatherResult(orgSettings: Record<string, unknown> | null, activeInitiatives: InitiativeRecord[]) {
  return {
    durationMs: 0,
    totalSignals: 3,
    orgSettings,
    orgName: 'KeyValue Systems',
    activeOutcomes: [],
    recentEmails: [],
    recentSlackMessages: [],
    todayEvents: [],
    recentInsights: [],
    recentFindings: [],
    topEntities: [],
    recentRelationships: [],
    recentMemories: [],
    workerViews: null,
    connectedIntegrations: [],
    proceduralMemories: [],
    workingMemory: null as WorkingMemory | null,
    focusProfile: {
      isActive: true,
      priorityTopics: ['Crane Ventures'],
      deprioritizedTopics: ['Axari'],
      instructions: 'Prioritize active client work.',
    },
    activeClaims: [
      {
        id: 'claim-1',
        artifactId: 'artifact-1',
        claimKind: 'fact',
        predicate: 'works_on',
        objectValue: 'Crane estimate',
        subjectEntityId: 'entity-crane',
        objectEntityId: null,
        updatedAt: '2026-03-13T08:10:00.000Z',
      },
    ],
    activeCommitments: [
      {
        id: 'commitment-1',
        title: 'Send Crane estimate',
        status: 'at_risk',
        priority: 'high',
        dueDate: '2026-03-14',
        updatedAt: '2026-03-13T08:15:00.000Z',
        linkedEntityIds: ['entity-crane'],
      },
    ],
    decisionThreads: [
      {
        id: 'decision-1',
        title: 'Crane pricing approach',
        status: 'open',
        relatedEntityIds: ['entity-crane'],
        updatedAt: '2026-03-13T08:20:00.000Z',
      },
    ],
    activeNarratives: [
      {
        id: 'narrative-1',
        title: 'Crane <> KeyValue',
        narrativeType: 'relationship',
        summary: 'Crane is evaluating the revised estimate.',
        relatedEntityIds: ['entity-crane'],
        updatedAt: '2026-03-13T08:25:00.000Z',
      },
    ],
    recentSourceArtifacts: [
      {
        id: 'artifact-1',
        title: 'Crane <> KeyValue',
        channel: 'meeting',
        startedAt: '2026-03-13T08:00:00.000Z',
        endedAt: '2026-03-13T08:30:00.000Z',
        updatedAt: '2026-03-13T08:30:00.000Z',
      },
    ],
    vaultContext: [],
    activeInitiatives,
    chiefWorldModel: null,
    decisionAccuracy: {},
  }
}

describe('finalizeChiefLoopCloseout', () => {
  it('persists initiative-native closeout state and selectively regenerates vault docs when v3 is enabled', async () => {
    const previous = [buildInitiative()]
    const next = [
      buildInitiative({
        phase: 'execution',
        latestSummary: 'Crane is now executing against the revised estimate.',
      }),
    ]

    const persistWorkingMemory = vi.fn(async () => {})
    const refreshInitiatives = vi.fn(async () => next)
    const persistWorldModel = vi.fn(async () => {})
    const regenerateVault = vi.fn(async () => ['Narratives/Initiatives/crane-estimation.md'])
    const createAdminClient = vi.fn(() => ({ admin: true }) as never)

    const outcome = await finalizeChiefLoopCloseout({
      supabase: {} as never,
      orgId: 'org-1',
      nowIso: '2026-03-13T09:00:00.000Z',
      result: buildChiefResult(),
      decisions: [] as ChiefDecision[],
      gatherResult: buildGatherResult({
        features: {
          chief_world_model_v3: true,
        },
      }, previous),
    }, {
      persistWorkingMemory,
      refreshInitiatives,
      persistWorldModel,
      regenerateVault,
      createAdminClient,
    })

    expect(persistWorkingMemory).toHaveBeenCalledOnce()
    expect(refreshInitiatives).toHaveBeenCalledOnce()
    expect(persistWorldModel).toHaveBeenCalledOnce()
    expect(regenerateVault).toHaveBeenCalledOnce()
    expect(outcome.worldModelPlan.enabled).toBe(true)
    expect(outcome.worldModelPlan.changedInitiativeIds).toEqual(['initiative-1'])
    expect(outcome.worldModel.changedSinceLastRun.updatedInitiativeIds).toEqual(['initiative-1'])
    expect(outcome.carryForward.length).toBeGreaterThan(0)
  })

  it('skips selective vault regeneration when the v3 flag is disabled', async () => {
    const next = [
      buildInitiative(),
      buildInitiative({
        id: 'initiative-2',
        title: 'KeyValue staffing plan',
        goal: 'Align staffing for delivery.',
      }),
    ]

    const regenerateVault = vi.fn(async () => ['Narratives/Initiatives/crane-estimation.md'])

    const outcome = await finalizeChiefLoopCloseout({
      supabase: {} as never,
      orgId: 'org-1',
      nowIso: '2026-03-13T09:00:00.000Z',
      result: buildChiefResult(),
      decisions: [] as ChiefDecision[],
      gatherResult: buildGatherResult({
        features: {
          chief_world_model_v3: false,
        },
      }, []),
    }, {
      persistWorkingMemory: vi.fn(async () => {}),
      refreshInitiatives: vi.fn(async () => next),
      persistWorldModel: vi.fn(async () => {}),
      regenerateVault,
      createAdminClient: vi.fn(() => ({ admin: true }) as never),
    })

    expect(outcome.worldModelPlan.enabled).toBe(false)
    expect(outcome.worldModelPlan.changedInitiativeIds).toEqual(['initiative-1', 'initiative-2'])
    expect(regenerateVault).not.toHaveBeenCalled()
  })
})
