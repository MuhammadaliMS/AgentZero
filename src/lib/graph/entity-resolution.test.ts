import { describe, expect, it } from 'vitest'

import {
  findBestDeterministicEntityMatch,
  type EntityMatchCandidate,
} from '@/lib/graph/entity-resolution'

function buildCandidate(overrides: Partial<EntityMatchCandidate>): EntityMatchCandidate {
  return {
    id: overrides.id ?? 'entity-1',
    entityType: overrides.entityType ?? 'person',
    name: overrides.name ?? 'Unknown',
    canonicalName: overrides.canonicalName ?? overrides.name?.toLowerCase() ?? 'unknown',
    mentionCount: overrides.mentionCount ?? 1,
    attributes: overrides.attributes ?? {},
    aliases: overrides.aliases ?? [],
  }
}

describe('findBestDeterministicEntityMatch', () => {
  it('matches a person with minor spelling drift on the same full name', () => {
    const match = findBestDeterministicEntityMatch({
      candidate: buildCandidate({
        id: 'candidate',
        name: 'Prashant Nair',
        canonicalName: 'prashant nair',
      }),
      existing: [
        buildCandidate({
          id: 'person-1',
          name: 'Prashanth Nair',
          canonicalName: 'prashanth nair',
          mentionCount: 8,
        }),
      ],
    })

    expect(match?.entityId).toBe('person-1')
    expect(match?.strategy).toBe('deterministic_strong')
    expect(match?.score).toBeGreaterThanOrEqual(0.88)
  })

  it('matches organizations with equivalent base names but different suffixes', () => {
    const match = findBestDeterministicEntityMatch({
      candidate: buildCandidate({
        id: 'candidate',
        entityType: 'vendor',
        name: 'Crane VC',
        canonicalName: 'crane vc',
      }),
      existing: [
        buildCandidate({
          id: 'org-1',
          entityType: 'vendor',
          name: 'Crane Ventures',
          canonicalName: 'crane ventures',
          mentionCount: 5,
        }),
      ],
    })

    expect(match?.entityId).toBe('org-1')
    expect(match?.score).toBeGreaterThanOrEqual(0.9)
  })

  it('does not merge different people who only share a first name', () => {
    const match = findBestDeterministicEntityMatch({
      candidate: buildCandidate({
        id: 'candidate',
        name: 'Komal Shah',
        canonicalName: 'komal shah',
      }),
      existing: [
        buildCandidate({
          id: 'person-2',
          name: 'Komal Nawandar',
          canonicalName: 'komal nawandar',
          mentionCount: 12,
        }),
      ],
    })

    expect(match).toBeNull()
  })

  it('uses exact email identity as the strongest possible match', () => {
    const match = findBestDeterministicEntityMatch({
      candidate: buildCandidate({
        id: 'candidate',
        name: 'Muhammad Ali Bayramov',
        canonicalName: 'muhammad ali bayramov',
        attributes: { email: 'ali@keyvalue.systems' },
      }),
      existing: [
        buildCandidate({
          id: 'person-3',
          name: 'Muhammadali Bayramov',
          canonicalName: 'muhammadali bayramov',
          attributes: { email: 'ali@keyvalue.systems' },
          mentionCount: 10,
        }),
      ],
    })

    expect(match?.entityId).toBe('person-3')
    expect(match?.score).toBe(1)
    expect(match?.reason).toContain('email')
  })

  it('matches collapsed and spaced first-name variants for the same person', () => {
    const match = findBestDeterministicEntityMatch({
      candidate: buildCandidate({
        id: 'candidate',
        name: 'Muhammad Ali Bayramov',
        canonicalName: 'muhammad ali bayramov',
      }),
      existing: [
        buildCandidate({
          id: 'person-4',
          name: 'Muhammadali Bayramov',
          canonicalName: 'muhammadali bayramov',
          mentionCount: 4,
        }),
      ],
    })

    expect(match?.entityId).toBe('person-4')
    expect(match?.score).toBeGreaterThanOrEqual(0.88)
  })
})
