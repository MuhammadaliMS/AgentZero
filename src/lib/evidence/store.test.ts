import { describe, expect, it } from 'vitest'

import { sanitizeMemoryCategory, splitIntoChunks } from '@/lib/evidence/store'

describe('sanitizeMemoryCategory', () => {
  it('passes through supported evidence memory categories', () => {
    expect(sanitizeMemoryCategory('meeting_outcome')).toBe('meeting_outcome')
    expect(sanitizeMemoryCategory('strategic_insight')).toBe('strategic_insight')
  })

  it('falls back unknown categories to context', () => {
    expect(sanitizeMemoryCategory('random_new_type')).toBe('context')
    expect(sanitizeMemoryCategory('')).toBe('context')
  })
})

describe('splitIntoChunks', () => {
  it('splits arrays into stable chunk sizes', () => {
    expect(splitIntoChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})
