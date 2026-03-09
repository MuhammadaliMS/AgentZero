'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { GraphToolbar } from './graph-toolbar'
import { GraphStatsPanel } from './graph-stats-panel'
import { EntityDetailPanel, type EntityNode, type RelationshipEdge } from './entity-detail-panel'
import { getEntityColor } from './entity-type-badge'
import { Loader2, Network } from 'lucide-react'

// Dynamic import — react-force-graph-2d uses Canvas/WebGL and can't SSR
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false })

interface GraphNode {
  id: string
  name: string
  entity_type: string
  color: string
  mention_count: number
  val: number // node size
  connections: number
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

  // Stats panel
  const [statsOpen, setStatsOpen] = useState(false)

  // Container dimensions
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })

  // Hovered node for highlight
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)

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

  // Configure d3 forces for better spread across the full canvas
  const [graphMounted, setGraphMounted] = useState(false)
  useEffect(() => {
    if (loading || graphMounted) return
    // Wait a tick for the graph ref to be available
    const timer = setTimeout(() => {
      const fg = graphRef.current
      if (!fg) return
      // Stronger charge repulsion to spread nodes across entire canvas
      fg.d3Force('charge')?.strength(-200)
      // Increase link distance so connected nodes don't cluster too tightly
      fg.d3Force('link')?.distance(80)
      // Re-heat the simulation so the new forces take effect
      fg.d3ReheatSimulation()
      setGraphMounted(true)
    }, 100)
    return () => clearTimeout(timer)
  }, [loading, graphMounted])

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

  // Connection count per entity
  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of relationships) {
      counts.set(r.source_entity_id, (counts.get(r.source_entity_id) || 0) + 1)
      counts.set(r.target_entity_id, (counts.get(r.target_entity_id) || 0) + 1)
    }
    return counts
  }, [relationships])

  // Entity type counts (for stats)
  const entityTypeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of entities) {
      counts.set(e.entity_type, (counts.get(e.entity_type) || 0) + 1)
    }
    return counts
  }, [entities])

  // Relationship type counts (for stats)
  const relationshipTypeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of relationships) {
      counts.set(r.relationship_type, (counts.get(r.relationship_type) || 0) + 1)
    }
    return counts
  }, [relationships])

  // Top connected entities
  const topConnected = useMemo(() => {
    return entities
      .map(e => ({ ...e, connections: connectionCounts.get(e.id) || 0 }))
      .sort((a, b) => b.connections - a.connections)
      .slice(0, 8)
  }, [entities, connectionCounts])

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
      connections: connectionCounts.get(e.id) || 0,
      val: Math.max(3, Math.min(16, Math.sqrt((connectionCounts.get(e.id) || 1) + e.mention_count) * 2)),
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
  }, [entities, relationships, searchQuery, activeFilters, connectionCounts])

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
      graphRef.current.zoomToFit(400, 30)
    }
  }, [])

  const handleNodeClick = useCallback((node: any) => {
    const entity = entityMap.get(node.id)
    if (entity) {
      setSelectedEntity(entity)
      setPanelOpen(true)
    }
  }, [entityMap])

  const handleNodeHover = useCallback((node: any) => {
    setHoveredNode(node?.id || null)
    if (containerRef.current) {
      containerRef.current.style.cursor = node ? 'pointer' : 'default'
    }
  }, [])

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

  // Connected node IDs for hover highlight
  const hoveredNodeNeighbors = useMemo(() => {
    if (!hoveredNode) return new Set<string>()
    const neighbors = new Set<string>()
    neighbors.add(hoveredNode)
    for (const r of relationships) {
      if (r.source_entity_id === hoveredNode) neighbors.add(r.target_entity_id)
      if (r.target_entity_id === hoveredNode) neighbors.add(r.source_entity_id)
    }
    return neighbors
  }, [hoveredNode, relationships])

  // Custom node rendering
  const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const label = node.name
    const fontSize = Math.max(11 / globalScale, 1.5)
    const nodeRadius = node.val

    const isHovered = hoveredNode === node.id
    const isNeighbor = hoveredNodeNeighbors.has(node.id)
    const dimmed = hoveredNode != null && !isNeighbor

    // Glow for hovered node
    if (isHovered) {
      ctx.beginPath()
      ctx.arc(node.x, node.y, nodeRadius + 4, 0, 2 * Math.PI)
      ctx.fillStyle = `${node.color}30`
      ctx.fill()
    }

    // Node circle
    ctx.beginPath()
    ctx.arc(node.x, node.y, nodeRadius, 0, 2 * Math.PI)
    ctx.fillStyle = node.color
    ctx.globalAlpha = dimmed ? 0.15 : isHovered ? 1 : 0.85
    ctx.fill()
    ctx.globalAlpha = 1

    // Border
    if (isHovered || isNeighbor) {
      ctx.strokeStyle = node.color
      ctx.lineWidth = isHovered ? 1.5 : 0.8
      ctx.stroke()
    }

    // Label (show if zoomed in enough OR node is hovered/neighbor)
    if (globalScale > 0.6 || isHovered || (isNeighbor && globalScale > 0.3)) {
      const showLabel = !dimmed || isNeighbor
      if (showLabel) {
        ctx.font = `${isHovered ? 'bold ' : ''}${fontSize}px Inter, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'

        // Background for label
        const textWidth = ctx.measureText(label).width
        const padding = 2
        ctx.fillStyle = dimmed ? 'rgba(255,255,255,0.5)' : 'rgba(255, 255, 255, 0.9)'
        ctx.fillRect(
          node.x - textWidth / 2 - padding,
          node.y + nodeRadius + 2,
          textWidth + padding * 2,
          fontSize + padding * 2
        )

        ctx.fillStyle = dimmed ? '#999' : '#1a1a1a'
        ctx.fillText(label, node.x, node.y + nodeRadius + 3)
      }
    }
  }, [hoveredNode, hoveredNodeNeighbors])

  // Custom link rendering
  const paintLink = useCallback((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const start = link.source
    const end = link.target
    if (!start || !end || start.x == null || end.x == null) return

    const isHighlighted = hoveredNode != null && (
      (start.id === hoveredNode || end.id === hoveredNode)
    )
    const dimmed = hoveredNode != null && !isHighlighted

    ctx.beginPath()
    ctx.moveTo(start.x, start.y)
    ctx.lineTo(end.x, end.y)

    if (isHighlighted) {
      ctx.strokeStyle = `rgba(99, 102, 241, 0.6)`
      ctx.lineWidth = Math.max(1, link.confidence * 2) / globalScale
    } else {
      ctx.strokeStyle = `rgba(148, 163, 184, ${dimmed ? 0.04 : Math.max(0.1, link.confidence * 0.3)})`
      ctx.lineWidth = Math.max(0.3, link.confidence * 1.2) / globalScale
    }

    ctx.stroke()

    // Show relationship label when hovered and zoomed in
    if (isHighlighted && globalScale > 1) {
      const midX = (start.x + end.x) / 2
      const midY = (start.y + end.y) / 2
      const label = link.relationship_type.replace(/_/g, ' ')
      const fontSize = Math.max(8 / globalScale, 1)
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.fillRect(midX - tw / 2 - 2, midY - fontSize / 2 - 1, tw + 4, fontSize + 2)
      ctx.fillStyle = '#6366f1'
      ctx.fillText(label, midX, midY)
    }
  }, [hoveredNode])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-gradient-to-br from-background to-muted/30">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading knowledge graph...</p>
        </div>
      </div>
    )
  }

  if (entities.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-gradient-to-br from-background to-muted/30">
        <div className="text-center space-y-3">
          <Network className="h-12 w-12 text-muted-foreground/30 mx-auto" />
          <p className="text-lg font-medium text-muted-foreground">No entities yet</p>
          <p className="text-sm text-muted-foreground/60 max-w-sm">
            The knowledge graph will populate as the AI processes meetings, conversations, and documents
          </p>
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      {/* Full-screen graph canvas */}
      <ForceGraph2D
        ref={graphRef}
        graphData={graphData}
        width={dimensions.width}
        height={dimensions.height}
        nodeCanvasObject={paintNode}
        linkCanvasObject={paintLink}
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        nodeLabel={() => ''} // we handle labels in paintNode
        enableNodeDrag={true}
        enableZoomInteraction={true}
        enablePanInteraction={true}
        cooldownTicks={200}
        warmupTicks={50}
        onEngineStop={() => {
          // Zoom to fit all nodes with minimal padding so graph fills the screen
          if (graphRef.current) {
            graphRef.current.zoomToFit(500, 30)
          }
        }}
        d3AlphaDecay={0.015}
        d3VelocityDecay={0.25}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        backgroundColor="rgba(0,0,0,0)"
      />

      {/* Floating toolbar overlay at top */}
      <div className="absolute top-0 left-0 right-0 z-10 pointer-events-none">
        <div className="pointer-events-auto">
          <GraphToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            entityTypes={entityTypes}
            activeFilters={activeFilters}
            onToggleFilter={handleToggleFilter}
            totalEntities={graphData.nodes.length}
            totalRelationships={graphData.links.length}
            onResetZoom={handleResetZoom}
            onToggleStats={() => setStatsOpen(prev => !prev)}
            statsOpen={statsOpen}
          />
        </div>
      </div>

      {/* Floating stats panel at bottom-left */}
      {statsOpen && (
        <div className="absolute bottom-4 left-4 z-10">
          <GraphStatsPanel
            entityTypeCounts={entityTypeCounts}
            relationshipTypeCounts={relationshipTypeCounts}
            topConnected={topConnected}
            totalEntities={entities.length}
            totalRelationships={relationships.length}
            onEntityClick={(entityId) => {
              handleNavigateToEntity(entityId)
              setPanelOpen(true)
            }}
          />
        </div>
      )}

      {/* Floating legend at bottom-right */}
      <div className="absolute bottom-4 right-4 z-10">
        <div className="bg-background/80 backdrop-blur-md border border-border/40 rounded-lg px-3 py-2 shadow-lg">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Legend</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            {entityTypes.map(type => (
              <button
                key={type}
                onClick={() => handleToggleFilter(type)}
                className="flex items-center gap-1.5 text-[10px] capitalize hover:opacity-80 transition-opacity py-0.5"
                style={{
                  opacity: activeFilters.has(type) ? 1 : 0.35,
                }}
              >
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: getEntityColor(type) }}
                />
                <span className="text-foreground/80">{type}</span>
                <span className="text-muted-foreground ml-auto">
                  {entityTypeCounts.get(type) || 0}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Entity detail sheet */}
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
