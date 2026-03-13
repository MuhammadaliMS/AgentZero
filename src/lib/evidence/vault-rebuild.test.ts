import { describe, expect, it } from 'vitest'

import { selectVaultDocumentsToPrune } from '@/lib/evidence/vault-rebuild'

describe('selectVaultDocumentsToPrune', () => {
  it('returns only stale generated vault paths that were not rebuilt', () => {
    const pruned = selectVaultDocumentsToPrune({
      existingPaths: [
        'Knowledge/Organizations/crane.md',
        'Knowledge/Organizations/old-crane.md',
        'Narratives/Relationships/crane-keyvalue.md',
      ],
      rebuiltPaths: [
        'Knowledge/Organizations/crane.md',
        'Narratives/Relationships/crane-keyvalue.md',
      ],
    })

    expect(pruned).toEqual([
      'Knowledge/Organizations/old-crane.md',
    ])
  })

  it('deduplicates rebuilt paths before pruning', () => {
    const pruned = selectVaultDocumentsToPrune({
      existingPaths: [
        'Briefs/2026-03-13.md',
        'Briefs/2026-03-12.md',
      ],
      rebuiltPaths: [
        'Briefs/2026-03-13.md',
        'Briefs/2026-03-13.md',
      ],
    })

    expect(pruned).toEqual(['Briefs/2026-03-12.md'])
  })
})
