export interface SelectVaultDocumentsToPruneInput {
  existingPaths: string[]
  rebuiltPaths: string[]
}

/**
 * Return stale vault document paths that should be removed after a full rebuild.
 */
export function selectVaultDocumentsToPrune(
  input: SelectVaultDocumentsToPruneInput
): string[] {
  const rebuilt = new Set(input.rebuiltPaths)
  return [...new Set(input.existingPaths)]
    .filter(path => !rebuilt.has(path))
    .sort()
}
