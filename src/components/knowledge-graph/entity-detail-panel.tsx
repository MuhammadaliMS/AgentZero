'use client'

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { EntityTypeBadge } from './entity-type-badge'
import { ArrowRight, ArrowLeft, Hash, Eye, Star, Calendar } from 'lucide-react'
import type { Json } from '@/types/database'

export interface EntityNode {
  id: string
  entity_type: string
  name: string
  canonical_name: string
  description: string | null
  attributes: Json | null
  mention_count: number
  utility_score: number
  state: string
  created_at: string
  first_seen_at: string
  last_seen_at: string
}

export interface RelationshipEdge {
  id: string
  source_entity_id: string
  target_entity_id: string
  relationship_type: string
  confidence: number
  properties: Json | null
  valid_from: string
  valid_to: string | null
}

interface EntityDetailPanelProps {
  entity: EntityNode | null
  relationships: RelationshipEdge[]
  allEntities: Map<string, EntityNode>
  open: boolean
  onOpenChange: (open: boolean) => void
  onNavigateToEntity: (entityId: string) => void
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function AttributesList({ attributes }: { attributes: Json | null }) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null
  const entries = Object.entries(attributes as Record<string, unknown>).filter(
    ([, v]) => v != null && v !== '' && v !== undefined
  )
  if (entries.length === 0) return null

  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Attributes</h4>
      <div className="rounded-lg border border-border/50 bg-muted/20 divide-y divide-border/30">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-start gap-2 px-3 py-2">
            <span className="text-[10px] font-medium text-muted-foreground min-w-[80px] shrink-0 capitalize">
              {key.replace(/_/g, ' ')}
            </span>
            <span className="text-xs text-foreground break-all">
              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function EntityDetailPanel({
  entity,
  relationships,
  allEntities,
  open,
  onOpenChange,
  onNavigateToEntity,
}: EntityDetailPanelProps) {
  if (!entity) return null

  const outgoing = relationships.filter(r => r.source_entity_id === entity.id)
  const incoming = relationships.filter(r => r.target_entity_id === entity.id)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <EntityTypeBadge entityType={entity.entity_type} />
            <span className="text-[10px] text-muted-foreground capitalize">{entity.state}</span>
          </div>
          <SheetTitle className="text-lg">{entity.name}</SheetTitle>
          {entity.canonical_name !== entity.name && (
            <p className="text-xs text-muted-foreground font-mono">{entity.canonical_name}</p>
          )}
          {entity.description && (
            <SheetDescription>{entity.description}</SheetDescription>
          )}
        </SheetHeader>

        <div className="px-4 space-y-5 pb-6">
          {/* Stats row */}
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg bg-muted/30 p-2.5 text-center">
              <Hash className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
              <p className="text-sm font-bold mt-1">{entity.mention_count}</p>
              <p className="text-[10px] text-muted-foreground">Mentions</p>
            </div>
            <div className="rounded-lg bg-muted/30 p-2.5 text-center">
              <Star className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
              <p className="text-sm font-bold mt-1">{entity.utility_score.toFixed(1)}</p>
              <p className="text-[10px] text-muted-foreground">Utility</p>
            </div>
            <div className="rounded-lg bg-muted/30 p-2.5 text-center">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
              <p className="text-sm font-bold mt-1">{formatDate(entity.first_seen_at)}</p>
              <p className="text-[10px] text-muted-foreground">First Seen</p>
            </div>
          </div>

          {/* Attributes */}
          <AttributesList attributes={entity.attributes} />

          {/* Outgoing relationships */}
          {outgoing.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <ArrowRight className="h-3 w-3" />
                Outgoing ({outgoing.length})
              </h4>
              <div className="space-y-1">
                {outgoing.map((rel) => {
                  const target = allEntities.get(rel.target_entity_id)
                  return (
                    <button
                      key={rel.id}
                      onClick={() => onNavigateToEntity(rel.target_entity_id)}
                      className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-muted/50 transition-colors cursor-pointer"
                    >
                      <span className="text-[10px] font-mono text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded shrink-0">
                        {rel.relationship_type.replace(/_/g, ' ')}
                      </span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
                      <span className="text-xs font-medium truncate">{target?.name || 'Unknown'}</span>
                      {target && (
                        <EntityTypeBadge entityType={target.entity_type} />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Incoming relationships */}
          {incoming.length > 0 && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <ArrowLeft className="h-3 w-3" />
                Incoming ({incoming.length})
              </h4>
              <div className="space-y-1">
                {incoming.map((rel) => {
                  const source = allEntities.get(rel.source_entity_id)
                  return (
                    <button
                      key={rel.id}
                      onClick={() => onNavigateToEntity(rel.source_entity_id)}
                      className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-muted/50 transition-colors cursor-pointer"
                    >
                      <span className="text-xs font-medium truncate">{source?.name || 'Unknown'}</span>
                      {source && (
                        <EntityTypeBadge entityType={source.entity_type} />
                      )}
                      <ArrowRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
                      <span className="text-[10px] font-mono text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded shrink-0">
                        {rel.relationship_type.replace(/_/g, ' ')}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {outgoing.length === 0 && incoming.length === 0 && (
            <p className="text-xs text-muted-foreground italic text-center py-2">No relationships</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
