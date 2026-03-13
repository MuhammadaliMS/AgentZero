export interface IntelligenceVaultTreeNode {
  name: string
  path: string
  type: 'folder' | 'document'
  children?: IntelligenceVaultTreeNode[]
}

export interface IntelligenceVaultEntryPoint {
  path: string
  title: string
  documentType: string
  updatedAt: string
  lastSourceUpdateAt: string | null
}

const CHANNEL_LABELS: Record<string, string> = {
  meeting: 'meeting',
  email: 'email',
  slack: 'Slack',
  chat: 'chat',
}

const CHANNEL_ORDER: Record<string, number> = {
  meeting: 0,
  email: 1,
  slack: 2,
  chat: 3,
}

/**
 * Flatten nested vault tree nodes into a document path list while preserving tree order.
 */
export function flattenVaultDocumentPaths(nodes: IntelligenceVaultTreeNode[]): string[] {
  const paths: string[] = []

  for (const node of nodes) {
    if (node.type === 'document') {
      paths.push(node.path)
      continue
    }

    if (Array.isArray(node.children) && node.children.length > 0) {
      paths.push(...flattenVaultDocumentPaths(node.children))
    }
  }

  return paths
}

/**
 * Build a compact readable summary of synced artifact channels.
 */
export function summarizeArtifactChannels(channels: string[]): string {
  if (channels.length === 0) {
    return 'No synced sources yet'
  }

  const counts = new Map<string, number>()
  for (const channel of channels) {
    counts.set(channel, (counts.get(channel) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return (CHANNEL_ORDER[left[0]] ?? 99) - (CHANNEL_ORDER[right[0]] ?? 99)
    })
    .map(([channel, count]) => {
      const baseLabel = CHANNEL_LABELS[channel] ?? channel
      const label = count === 1
        ? baseLabel
        : baseLabel === 'Slack'
          ? 'Slack threads'
          : `${baseLabel}s`
      return `${count} ${label}`
    })
    .join(', ')
}

export function groupEntryPointsByFreshness(entries: IntelligenceVaultEntryPoint[]): {
  fresh: IntelligenceVaultEntryPoint[]
  older: IntelligenceVaultEntryPoint[]
} {
  const now = Date.now()
  const fresh: IntelligenceVaultEntryPoint[] = []
  const older: IntelligenceVaultEntryPoint[] = []

  for (const entry of entries) {
    const ageHours = (now - new Date(entry.updatedAt).getTime()) / 3_600_000
    if (ageHours <= 48) {
      fresh.push(entry)
    } else {
      older.push(entry)
    }
  }

  return { fresh, older }
}

export function labelDocumentType(documentType: string): string {
  switch (documentType) {
    case 'source_artifact':
      return 'Source'
    case 'decision_thread':
      return 'Decision'
    case 'commitment':
      return 'Action item'
    case 'brief':
      return 'Brief'
    case 'narrative':
      return 'Narrative'
    default:
      return documentType.replace(/_/g, ' ')
  }
}
