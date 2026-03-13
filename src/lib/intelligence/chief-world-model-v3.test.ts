import { describe, expect, it } from 'vitest'

import { resolveChiefWorldModelV3Plan } from '@/lib/intelligence/chief-world-model-v3'
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

describe('resolveChiefWorldModelV3Plan', () => {
  it('returns only materially changed initiatives when the v3 flag is enabled', () => {
    const previous = [buildInitiative()]
    const next = [
      buildInitiative({
        phase: 'execution',
        latestSummary: 'Crane is now executing against the revised estimate.',
      }),
      buildInitiative({
        id: 'initiative-2',
        title: 'KeyValue staffing plan',
        goal: 'Align staffing for delivery.',
        latestSummary: 'A delivery staffing plan is now required.',
        linkedEntityIds: ['entity-keyvalue'],
        linkedClaimIds: [],
        linkedCommitmentIds: [],
        linkedDecisionThreadIds: [],
      }),
    ]

    const plan = resolveChiefWorldModelV3Plan({
      orgSettings: {
        features: {
          chief_world_model_v3: true,
        },
      },
      previousInitiatives: previous,
      nextInitiatives: next,
    })

    expect(plan.enabled).toBe(true)
    expect(plan.changedInitiativeIds).toEqual(['initiative-1', 'initiative-2'])
  })

  it('does not treat reconciliation timestamp churn as a material change when enabled', () => {
    const previous = [buildInitiative()]
    const next = [
      buildInitiative({
        lastReconciledAt: '2026-03-13T09:00:00.000Z',
        updatedAt: '2026-03-13T09:00:00.000Z',
      }),
    ]

    const plan = resolveChiefWorldModelV3Plan({
      orgSettings: {
        features: {
          chief_world_model_v3: true,
        },
      },
      previousInitiatives: previous,
      nextInitiatives: next,
    })

    expect(plan.enabled).toBe(true)
    expect(plan.changedInitiativeIds).toEqual([])
  })

  it('falls back to all active initiatives when the v3 flag is disabled', () => {
    const next = [
      buildInitiative(),
      buildInitiative({
        id: 'initiative-2',
        title: 'KeyValue staffing plan',
      }),
    ]

    const plan = resolveChiefWorldModelV3Plan({
      orgSettings: {
        features: {
          chief_world_model_v3: false,
        },
      },
      previousInitiatives: [],
      nextInitiatives: next,
    })

    expect(plan.enabled).toBe(false)
    expect(plan.changedInitiativeIds).toEqual(['initiative-1', 'initiative-2'])
  })
})
