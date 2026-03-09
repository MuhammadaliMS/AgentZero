'use client'

import { getEntityColor } from './entity-type-badge'
import { Network, TrendingUp, Link2, Users } from 'lucide-react'

interface TopEntity {
  id: string
  name: string
  entity_type: string
  connections: number
  mention_count: number
}

interface GraphStatsPanelProps {
  entityTypeCounts: Map<string, number>
  relationshipTypeCounts: Map<string, number>
  topConnected: TopEntity[]
  totalEntities: number
  totalRelationships: number
  onEntityClick: (entityId: string) => void
}

export function GraphStatsPanel({
  entityTypeCounts,
  relationshipTypeCounts,
  topConnected,
  totalEntities,
  totalRelationships,
  onEntityClick,
}: GraphStatsPanelProps) {
  const sortedEntityTypes = Array.from(entityTypeCounts.entries())
    .sort((a, b) => b[1] - a[1])

  const sortedRelTypes = Array.from(relationshipTypeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  // Calculate density (edges / max possible edges)
  const maxEdges = totalEntities * (totalEntities - 1) / 2
  const density = maxEdges > 0 ? (totalRelationships / maxEdges * 100).toFixed(2) : '0'

  // Average connections per entity
  const avgConnections = totalEntities > 0
    ? (totalRelationships * 2 / totalEntities).toFixed(1)
    : '0'

  return (
    <div className="bg-background/80 backdrop-blur-xl border border-border/30 rounded-xl shadow-lg w-80 max-h-[60vh] overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/30">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          Graph Insights
        </h3>
      </div>

      <div className="p-4 space-y-5">
        {/* Quick stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-primary/5 border border-primary/10 p-2 text-center">
            <Network className="h-3.5 w-3.5 text-primary mx-auto" />
            <p className="text-lg font-bold mt-0.5">{totalEntities}</p>
            <p className="text-[10px] text-muted-foreground">Entities</p>
          </div>
          <div className="rounded-lg bg-indigo-500/5 border border-indigo-500/10 p-2 text-center">
            <Link2 className="h-3.5 w-3.5 text-indigo-500 mx-auto" />
            <p className="text-lg font-bold mt-0.5">{totalRelationships}</p>
            <p className="text-[10px] text-muted-foreground">Relationships</p>
          </div>
          <div className="rounded-lg bg-emerald-500/5 border border-emerald-500/10 p-2 text-center">
            <Users className="h-3.5 w-3.5 text-emerald-500 mx-auto" />
            <p className="text-lg font-bold mt-0.5">{avgConnections}</p>
            <p className="text-[10px] text-muted-foreground">Avg Links</p>
          </div>
        </div>

        {/* Entity type breakdown */}
        <div>
          <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Entity Types
          </h4>
          <div className="space-y-1.5">
            {sortedEntityTypes.map(([type, count]) => {
              const color = getEntityColor(type)
              const pct = totalEntities > 0 ? (count / totalEntities) * 100 : 0
              return (
                <div key={type} className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span className="text-xs capitalize flex-1">{type}</span>
                  <span className="text-[10px] text-muted-foreground">{count}</span>
                  <div className="w-16 h-1.5 bg-muted/50 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: color }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Top connected entities */}
        {topConnected.length > 0 && (
          <div>
            <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Most Connected
            </h4>
            <div className="space-y-0.5">
              {topConnected.map((entity, i) => {
                const color = getEntityColor(entity.entity_type)
                return (
                  <button
                    key={entity.id}
                    onClick={() => onEntityClick(entity.id)}
                    className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted/40 transition-colors cursor-pointer group"
                  >
                    <span className="text-[10px] text-muted-foreground w-4 text-right shrink-0">
                      {i + 1}.
                    </span>
                    <span
                      className="h-1.5 w-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-xs font-medium truncate flex-1 group-hover:text-primary transition-colors">
                      {entity.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {entity.connections} links
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Relationship types */}
        {sortedRelTypes.length > 0 && (
          <div>
            <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Relationship Types
            </h4>
            <div className="flex flex-wrap gap-1">
              {sortedRelTypes.map(([type, count]) => (
                <span
                  key={type}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono
                             bg-muted/40 text-muted-foreground border border-border/30"
                >
                  {type.replace(/_/g, ' ')}
                  <span className="font-semibold text-foreground">{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Graph density */}
        <div className="rounded-lg bg-muted/20 border border-border/30 p-2.5">
          <p className="text-[10px] text-muted-foreground">
            Graph density: <span className="font-semibold text-foreground">{density}%</span>
            <span className="text-muted-foreground/60"> — {totalEntities} nodes, {totalRelationships} edges</span>
          </p>
        </div>
      </div>
    </div>
  )
}
