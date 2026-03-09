'use client'

export const ENTITY_TYPE_COLORS: Record<string, string> = {
  person: '#3b82f6',
  project: '#8b5cf6',
  control: '#ef4444',
  decision: '#f59e0b',
  team: '#10b981',
  tool: '#6366f1',
  vendor: '#ec4899',
  framework: '#14b8a6',
  document: '#64748b',
  process: '#f97316',
  feature: '#06b6d4',
  customer: '#84cc16',
  metric: '#a855f7',
}

export function getEntityColor(entityType: string): string {
  return ENTITY_TYPE_COLORS[entityType.toLowerCase()] || '#94a3b8'
}

export function EntityTypeBadge({ entityType }: { entityType: string }) {
  const color = getEntityColor(entityType)

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize"
      style={{
        backgroundColor: `${color}15`,
        color: color,
        border: `1px solid ${color}30`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full shrink-0"
        style={{ backgroundColor: color }}
      />
      {entityType}
    </span>
  )
}
