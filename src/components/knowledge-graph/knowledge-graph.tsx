'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { GraphToolbar } from './graph-toolbar'
import { EntityDetailPanel, type EntityNode, type RelationshipEdge } from './entity-detail-panel'
import { getEntityColor } from './entity-type-badge'
import { Loader2 } from 'lucide-react'

// Dynamic import — react-force-graph-2d uses Canvas/WebGL and can't SSR
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false })

interface GraphNode {
  id: string
  name: string
  entity_type: string
  color: string
  mention_count: number
  val: number // node size
  // Force graph adds x, y, vx, vy at runtime
  x?: number
  y?: number
}

interface GraphLink {
  source: string
  target: string
  relationship_type: string
  confidence: number
  id: string
}

export function KnowledgeGraph() {
  const supabase = createClient()
  const graphRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [entities, setEntities] = useState<EntityNode[]>([])
  const [relationships, setRelationships] = useState<RelationshipEdge[]>([])
  const [loading, setLoading] = useState(true)

  // Toolbar state
  const [searchQuery, setSearchQuery] = useState('')
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())

  // Detail panel
  const [selectedEntity, setSelectedEntity] = useState<EntityNode | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)

  // Container dimensions
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })

  // Load data
  useEffect(() => {
    async function load() {
      try {
        const [entitiesRes, relsRes] = await Promise.all([
          supabase
            .from('entities')
            .select('id, entity_type, name, canonical_name, description, attributes, mention_count, utility_score, state, created_at, first_seen_at, last_seen_at')
            .eq('state', 'active')
            .order('mention_count', { ascending: false })
            .limit(500),
          supabase
            .from('entity_relationships')
            .select('id, source_entity_id, target_entity_id, relationship_type, confidence, properties, valid_from, valid_to')
            .is('valid_to', null) // only current relationships
            .order('confidence', { ascending: false })
            .limit(2000),
        ])

        setEntities((entitiesRes.data || []) as EntityNode[])
        setRelationships((relsRes.data || []) as RelationshipEdge[])
      } catch (e) {
        console.error('Failed to load graph data:', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [supabase])

  // Resize observer
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Entity lookup map
  const entityMap = useMemo(() => {
    const map = new Map<string, EntityNode>()
    for (const e of entities) map.set(e.id, e)
    return map
  }, [entities])

  // Available entity types
  const entityTypes = useMemo(() => {
    const types = new Set<string>()
    for (const e of entities) types.add(e.entity_type)
    return Array.from(types).sort()
  }, [entities])

  // Initialize filters to show all types
  useEffect(() => {
    if (entityTypes.length > 0 && activeFilters.size === 0) {
      setActiveFilters(new Set(entityTypes))
    }
  }, [entityTypes, activeFilters.size])

  // Filtered graph data
  const graphData = useMemo(() => {
    const lowerQuery = searchQuery.toLowerCase()

    // Filter entities
    const filteredEntities = entities.filter((e) => {
      if (!activeFilters.has(e.entity_type)) return false
      if (lowerQuery && !e.name.toLowerCase().includes(lowerQuery) && !e.canonical_name.toLowerCase().includes(lowerQuery)) return false
      return true
    })

    const entityIds = new Set(filteredEntities.map(e => e.id))

    // Nodes
    const nodes: GraphNode[] = filteredEntities.map((e) => ({
      id: e.id,
      name: e.name,
      entity_type: e.entity_type,
      color: getEntityColor(e.entity_type),
      mention_count: e.mention_count,
      val: Math.max(2, Math.min(12, Math.sqrt(e.mention_count) * 2)),
    }))

    // Links — only if both source and target are visible
    const links: GraphLink[] = relationships
      .filter(r => entityIds.has(r.source_entity_id) && entityIds.has(r.target_entity_id))
      .map(r => ({
        source: r.source_entity_id,
        target: r.target_entity_id,
        relationship_type: r.relationship_type,
        confidence: r.confidence,
        id: r.id,
      }))

    return { nodes, links }
  }, [entities, relationships, searchQuery, activeFilters])

  const handleToggleFilter = useCallback((type: string) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
  }, [])

  const handleResetZoom = useCallback(() => {
    if (graphRef.current) {
      graphRef.current.zoomToFit(400, 40)
    }
  }, [])

  const handleNodeClick = useCallback((node: any) => {
    const entity = entityMap.get(node.id)
    if (entity) {
      setSelectedEntity(entity)
      setPanelOpen(true)
    }
  }, [entityMap])

  const handleNavigateToEntity = useCallback((entityId: string) => {
    const entity = entityMap.get(entityId)
    if (entity) {
      setSelectedEntity(entity)
      // Center graph on this node
      if (graphRef.current) {
        const node = graphData.nodes.find(n => n.id === entityId)
        if (node && node.x != null && node.y != null) {
          graphRef.current.centerAt(node.x, node.y, 500)
          graphRef.current.zoom(2, 500)
        }
      }
    }
  }, [entityMap, graphData.nodes])

  // Custom node rendering
  const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const label = node.name
    const fontSize = Math.max(10 / globalScale, 1.5)
    const nodeRadius = node.val

    // Node circle
    ctx.beginPath()
    ctx.arc(node.x, node.y, nodeRadius, 0, 2 * Math.PI)
    ctx.fillStyle = node.color
    ctx.globalAlpha = 0.85
    ctx.fill()
    ctx.globalAlpha = 1

    // Border
    ctx.strokeStyle = node.color
    ctx.lineWidth = 0.5
    ctx.stroke()

    // Label (only show if zoomed in enough)
    if (globalScale > 0.6) {
      ctx.font = `${fontSize}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = 'var(--foreground, #333)'

      // Background for label
      const textWidth = ctx.measureText(label).width
      const padding = 1
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
      ctx.fillRect(
        node.x - textWidth / 2 - padding,
        node.y + nodeRadius + 1,
        textWidth + padding * 2,
        fontSize + padding * 2
      )

      ctx.fillStyle = '#333'
      ctx.fillText(label, node.x, node.y + nodeRadius + 2)
    }
  }, [])

  // Custom link rendering
  const paintLink = useCallback((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const start = link.source
    const end = link.target
    if (!start || !end || start.x == null || end.x == null) return

    ctx.beginPath()
    ctx.moveTo(start.x, start.y)
    ctx.lineTo(end.x, end.y)
    ctx.strokeStyle = `rgba(148, 163, 184, ${Math.max(0.15, link.confidence * 0.4)})`
    ctx.lineWidth = Math.max(0.3, link.confidence * 1.5) / globalScale
    ctx.stroke()
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading knowledge graph...</p>
        </div>
      </div>
    )
  }

  if (entities.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-lg font-medium text-muted-foreground">No entities yet</p>
          <p className="text-sm text-muted-foreground/60 mt-1">
            The knowledge graph will populate as the AI processes conversations and data
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <GraphToolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        entityTypes={entityTypes}
        activeFilters={activeFilters}
        onToggleFilter={handleToggleFilter}
        totalEntities={graphData.nodes.length}
        totalRelationships={graphData.links.length}
        onResetZoom={handleResetZoom}
      />

      <div ref={containerRef} className="flex-1 min-h-0 relative bg-background">
        <ForceGraph2D
          ref={graphRef}
          graphData={graphData}
          width={dimensions.width}
          height={dimensions.height}
          nodeCanvasObject={paintNode}
          linkCanvasObject={paintLink}
          onNodeClick={handleNodeClick}
          nodeLabel={(node: any) => `${node.name} (${node.entity_type})`}
          enableNodeDrag={true}
          enableZoomInteraction={true}
          enablePanInteraction={true}
          cooldownTicks={100}
          onEngineStop={() => {
            if (graphRef.current) {
              graphRef.current.zoomToFit(400, 40)
            }
          }}
          d3AlphaDecay={0.02}
          d3VelocityDecay={0.3}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
        />
      </div>

      <EntityDetailPanel
        entity={selectedEntity}
        relationships={relationships}
        allEntities={entityMap}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        onNavigateToEntity={handleNavigateToEntity}
      />
    </div>
  )
}
