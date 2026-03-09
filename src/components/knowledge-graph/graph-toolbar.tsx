'use client'

import { Search, RotateCcw } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { getEntityColor } from './entity-type-badge'

interface GraphToolbarProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  entityTypes: string[]
  activeFilters: Set<string>
  onToggleFilter: (type: string) => void
  totalEntities: number
  totalRelationships: number
  onResetZoom: () => void
}

export function GraphToolbar({
  searchQuery,
  onSearchChange,
  entityTypes,
  activeFilters,
  onToggleFilter,
  totalEntities,
  totalRelationships,
  onResetZoom,
}: GraphToolbarProps) {
  return (
    <div className="flex flex-col gap-3 p-4 border-b border-border/40 bg-background/80 backdrop-blur-sm">
      {/* Top row: search + stats + reset */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search entities..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span><span className="font-medium text-foreground">{totalEntities}</span> entities</span>
          <span><span className="font-medium text-foreground">{totalRelationships}</span> relationships</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onResetZoom} className="h-7 px-2 text-xs gap-1">
          <RotateCcw className="h-3 w-3" />
          Reset
        </Button>
      </div>

      {/* Filter pills */}
      {entityTypes.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {entityTypes.map((type) => {
            const color = getEntityColor(type)
            const isActive = activeFilters.has(type)
            return (
              <button
                key={type}
                onClick={() => onToggleFilter(type)}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize
                           transition-all duration-150 cursor-pointer border"
                style={{
                  backgroundColor: isActive ? `${color}15` : 'transparent',
                  color: isActive ? color : 'var(--muted-foreground)',
                  borderColor: isActive ? `${color}40` : 'var(--border)',
                  opacity: isActive ? 1 : 0.6,
                }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: isActive ? color : 'var(--muted-foreground)' }}
                />
                {type}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
