'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Clock3,
  FolderTree,
  GitBranch,
  Hash,
  Mail,
  MessageCircle,
  Network,
  RefreshCw,
  Sparkles,
  Video,
} from 'lucide-react'

import { AIActivityView } from '@/components/command-center/ai-activity-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { createClient } from '@/lib/supabase/client'
import {
  flattenVaultDocumentPaths,
  summarizeArtifactChannels,
  type IntelligenceVaultTreeNode,
} from '@/lib/evidence/intelligence-ui'

type TimelineTarget =
  | { type: 'decision_thread'; id: string; label: string }
  | { type: 'commitment'; id: string; label: string }
  | { type: 'entity'; id: string; label: string }

interface DashboardStats {
  syncedSources: number
  evidenceItems: number
  activeClaims: number
  openCommitments: number
  decisionThreads: number
  vaultDocs: number
  memories: number
  narratives: number
}

interface IntegrationStatusRow {
  key: string
  health_status: string | null
}

interface ArtifactRow {
  id: string
  channel: 'meeting' | 'slack' | 'email' | 'chat'
  title: string
  created_at: string
  started_at: string | null
  source_url: string | null
  metadata: Record<string, unknown> | null
  evidenceCount: number
  claimCount: number
}

interface CommitmentRow {
  id: string
  title: string
  status: string
  due_date: string | null
  updated_at: string
  priority: string
}

interface DecisionThreadRow {
  id: string
  title: string
  status: string
  updated_at: string
  related_entity_ids: string[] | null
}

interface NarrativeRow {
  id: string
  title: string
  narrative_type: string
  summary: string
  updated_at: string
}

interface MemoryRow {
  id: string
  subject: string
  category: string
  content: string
  created_at: string
}

interface EntityRow {
  id: string
  name: string
  entity_type: string
  updated_at: string
}

interface VaultDocumentResponse {
  document: {
    id: string
    path: string
    title: string
    document_type: string
    content_markdown: string
    frontmatter: Record<string, unknown> | null
    source_mode: string
  }
  links: Array<{ link_kind: string; target_id: string }>
}

interface TimelineResponse {
  scope: string
  entityId?: string
  timeline: Array<Record<string, unknown>>
  decisionThread?: Record<string, unknown>
  commitment?: Record<string, unknown>
}

const CHANNEL_META = {
  meeting: {
    label: 'Meeting',
    icon: Video,
    badge: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200/60 dark:bg-blue-950/30 dark:text-blue-300 dark:ring-blue-800/40',
  },
  email: {
    label: 'Email',
    icon: Mail,
    badge: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60 dark:bg-amber-950/30 dark:text-amber-300 dark:ring-amber-800/40',
  },
  slack: {
    label: 'Slack',
    icon: Hash,
    badge: 'bg-pink-50 text-pink-700 ring-1 ring-pink-200/60 dark:bg-pink-950/30 dark:text-pink-300 dark:ring-pink-800/40',
  },
  chat: {
    label: 'Chat',
    icon: MessageCircle,
    badge: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200/60 dark:bg-violet-950/30 dark:text-violet-300 dark:ring-violet-800/40',
  },
} as const

const COMMITMENT_STATUS_BADGES: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300',
  at_risk: 'bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300',
  overdue: 'bg-red-50 text-red-700 dark:bg-red-950/20 dark:text-red-300',
  completed: 'bg-sky-50 text-sky-700 dark:bg-sky-950/20 dark:text-sky-300',
  cancelled: 'bg-muted text-muted-foreground',
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'Unknown'
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Unknown'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatClaimLabel(claim: Record<string, unknown>): string {
  const predicate = typeof claim.predicate === 'string' ? claim.predicate : 'related_to'
  const objectValue = typeof claim.object_value === 'string'
    ? claim.object_value
    : typeof claim.objectValue === 'string'
      ? claim.objectValue
      : typeof claim.object_entity_id === 'string'
        ? claim.object_entity_id
        : typeof claim.objectEntityId === 'string'
          ? claim.objectEntityId
          : null

  return objectValue ? `${predicate} -> ${objectValue}` : predicate
}

function StatCard({
  title,
  value,
  hint,
  accent,
}: {
  title: string
  value: number
  hint: string
  accent: string
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card/90 p-4 shadow-sm">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{title}</p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="text-3xl font-semibold tracking-tight">{value}</p>
        <span className={`h-2.5 w-2.5 rounded-full ${accent}`} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function VaultTreeBranch({
  nodes,
  selectedPath,
  expandedFolders,
  onToggleFolder,
  onSelectDocument,
}: {
  nodes: IntelligenceVaultTreeNode[]
  selectedPath: string | null
  expandedFolders: Set<string>
  onToggleFolder: (path: string) => void
  onSelectDocument: (path: string) => void
}) {
  return (
    <ul className="space-y-1">
      {nodes.map((node) => {
        if (node.type === 'document') {
          const selected = node.path === selectedPath
          return (
            <li key={node.path}>
              <button
                onClick={() => onSelectDocument(node.path)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  selected
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                }`}
              >
                <BookOpen className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{node.name.replace(/\.md$/, '')}</span>
              </button>
            </li>
          )
        }

        const isOpen = expandedFolders.has(node.path)
        return (
          <li key={node.path}>
            <button
              onClick={() => onToggleFolder(node.path)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted/40"
            >
              {isOpen ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <FolderTree className="h-3.5 w-3.5 text-primary" />
              <span className="truncate">{node.name}</span>
            </button>
            {isOpen && node.children && node.children.length > 0 && (
              <div className="ml-4 border-l border-border/40 pl-3">
                <VaultTreeBranch
                  nodes={node.children}
                  selectedPath={selectedPath}
                  expandedFolders={expandedFolders}
                  onToggleFolder={onToggleFolder}
                  onSelectDocument={onSelectDocument}
                />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function IntelligenceWorkspace() {
  const supabase = useMemo(() => createClient() as any, [])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [integrations, setIntegrations] = useState<IntegrationStatusRow[]>([])
  const [latestSyncRun, setLatestSyncRun] = useState<Record<string, unknown> | null>(null)
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([])
  const [commitments, setCommitments] = useState<CommitmentRow[]>([])
  const [decisionThreads, setDecisionThreads] = useState<DecisionThreadRow[]>([])
  const [narratives, setNarratives] = useState<NarrativeRow[]>([])
  const [memories, setMemories] = useState<MemoryRow[]>([])
  const [entities, setEntities] = useState<EntityRow[]>([])
  const [vaultTree, setVaultTree] = useState<IntelligenceVaultTreeNode[]>([])
  const [selectedVaultPath, setSelectedVaultPath] = useState<string | null>(null)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [vaultDocument, setVaultDocument] = useState<VaultDocumentResponse | null>(null)
  const [vaultLoading, setVaultLoading] = useState(false)
  const [timelineTarget, setTimelineTarget] = useState<TimelineTarget | null>(null)
  const [timelineResponse, setTimelineResponse] = useState<TimelineResponse | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadWorkspace() {
      setLoading(true)
      setError(null)

      try {
        const since = new Date()
        since.setDate(since.getDate() - 7)
        const sinceIso = since.toISOString()

        const [
          sourceCountRes,
          evidenceCountRes,
          claimsCountRes,
          commitmentsCountRes,
          decisionThreadsCountRes,
          vaultDocsCountRes,
          memoriesCountRes,
          narrativesCountRes,
          artifactsRes,
          commitmentsRes,
          decisionThreadsRes,
          narrativesRes,
          memoriesRes,
          entitiesRes,
          integrationsRes,
          syncRunsRes,
          treeRes,
        ] = await Promise.all([
          supabase.from('source_artifacts').select('id', { count: 'exact', head: true }),
          supabase.from('evidence_items').select('id', { count: 'exact', head: true }),
          supabase.from('claims').select('id', { count: 'exact', head: true }).eq('status', 'active'),
          supabase.from('commitments').select('id', { count: 'exact', head: true }).in('status', ['active', 'at_risk', 'overdue']),
          supabase.from('decision_threads').select('id', { count: 'exact', head: true }),
          supabase.from('vault_documents').select('id', { count: 'exact', head: true }),
          supabase.from('memory').select('id', { count: 'exact', head: true }),
          supabase.from('strategic_narratives').select('id', { count: 'exact', head: true }).eq('status', 'active'),
          supabase
            .from('source_artifacts')
            .select('id, channel, title, created_at, started_at, source_url, metadata')
            .order('created_at', { ascending: false })
            .limit(12),
          supabase
            .from('commitments')
            .select('id, title, status, due_date, updated_at, priority')
            .order('updated_at', { ascending: false })
            .limit(8),
          supabase
            .from('decision_threads')
            .select('id, title, status, updated_at, related_entity_ids')
            .order('updated_at', { ascending: false })
            .limit(8),
          supabase
            .from('strategic_narratives')
            .select('id, title, narrative_type, summary, updated_at')
            .eq('status', 'active')
            .order('updated_at', { ascending: false })
            .limit(6),
          supabase
            .from('memory')
            .select('id, subject, category, content, created_at')
            .order('updated_at', { ascending: false })
            .limit(6),
          supabase
            .from('entities')
            .select('id, name, entity_type, updated_at')
            .order('updated_at', { ascending: false })
            .limit(8),
          supabase
            .from('organization_integrations')
            .select('health_status, integrations!inner(key)')
            .eq('is_active', true),
          supabase
            .from('worker_executions')
            .select('id, worker, status, created_at, completed_at, duration_ms, output_summary, error')
            .eq('worker', 'daily-evidence-sync')
            .gte('created_at', sinceIso)
            .order('created_at', { ascending: false })
            .limit(3),
          fetch('/api/vault/tree').then(async (response) => {
            if (!response.ok) throw new Error('Failed to load vault tree')
            return response.json()
          }),
        ])

        const recentArtifacts = (artifactsRes.data ?? []) as Array<{
          id: string
          channel: 'meeting' | 'slack' | 'email' | 'chat'
          title: string
          created_at: string
          started_at: string | null
          source_url: string | null
          metadata: Record<string, unknown> | null
        }>

        const artifactIds = recentArtifacts.map((artifact) => artifact.id)
        const [artifactEvidenceRes, artifactClaimsRes] = artifactIds.length > 0
          ? await Promise.all([
            supabase.from('evidence_items').select('artifact_id').in('artifact_id', artifactIds),
            supabase.from('claims').select('artifact_id').in('artifact_id', artifactIds),
          ])
          : [{ data: [] }, { data: [] }]

        const evidenceCounts = new Map<string, number>()
        for (const row of (artifactEvidenceRes.data ?? []) as Array<{ artifact_id: string }>) {
          evidenceCounts.set(row.artifact_id, (evidenceCounts.get(row.artifact_id) ?? 0) + 1)
        }

        const claimCounts = new Map<string, number>()
        for (const row of (artifactClaimsRes.data ?? []) as Array<{ artifact_id: string }>) {
          claimCounts.set(row.artifact_id, (claimCounts.get(row.artifact_id) ?? 0) + 1)
        }

        const nextArtifacts = recentArtifacts.map((artifact) => ({
          ...artifact,
          evidenceCount: evidenceCounts.get(artifact.id) ?? 0,
          claimCount: claimCounts.get(artifact.id) ?? 0,
        }))

        const nextTree = Array.isArray(treeRes.tree) ? treeRes.tree as IntelligenceVaultTreeNode[] : []
        const documentPaths = flattenVaultDocumentPaths(nextTree)

        if (!cancelled) {
          setStats({
            syncedSources: sourceCountRes.count ?? 0,
            evidenceItems: evidenceCountRes.count ?? 0,
            activeClaims: claimsCountRes.count ?? 0,
            openCommitments: commitmentsCountRes.count ?? 0,
            decisionThreads: decisionThreadsCountRes.count ?? 0,
            vaultDocs: vaultDocsCountRes.count ?? 0,
            memories: memoriesCountRes.count ?? 0,
            narratives: narrativesCountRes.count ?? 0,
          })
          setArtifacts(nextArtifacts)
          setCommitments((commitmentsRes.data ?? []) as CommitmentRow[])
          setDecisionThreads((decisionThreadsRes.data ?? []) as DecisionThreadRow[])
          setNarratives((narrativesRes.data ?? []) as NarrativeRow[])
          setMemories((memoriesRes.data ?? []) as MemoryRow[])
          setEntities((entitiesRes.data ?? []) as EntityRow[])
          setIntegrations(
            ((integrationsRes.data ?? []) as Array<{ health_status: string | null; integrations: { key: string } }>)
              .map((row) => ({
                key: row.integrations.key,
                health_status: row.health_status,
              }))
          )
          setLatestSyncRun(((syncRunsRes.data ?? []) as Array<Record<string, unknown>>)[0] ?? null)
          setVaultTree(nextTree)
          setExpandedFolders(new Set(nextTree.map((node) => node.path)))
          setSelectedVaultPath((current) => current ?? documentPaths[0] ?? null)
        }
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error ? loadError.message : 'Failed to load intelligence workspace'
          setError(message)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadWorkspace()
    const interval = setInterval(loadWorkspace, 60_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [supabase])

  useEffect(() => {
    if (!selectedVaultPath) {
      setVaultDocument(null)
      return
    }

    const path = selectedVaultPath
    let cancelled = false

    async function loadVaultDocument() {
      setVaultLoading(true)
      try {
        const response = await fetch(`/api/vault/document?path=${encodeURIComponent(path)}`)
        if (!response.ok) {
          throw new Error('Failed to load vault document')
        }
        const payload = await response.json() as VaultDocumentResponse
        if (!cancelled) {
          setVaultDocument(payload)
        }
      } catch (loadError) {
        if (!cancelled) {
          setVaultDocument(null)
        }
      } finally {
        if (!cancelled) {
          setVaultLoading(false)
        }
      }
    }

    loadVaultDocument()

    return () => {
      cancelled = true
    }
  }, [selectedVaultPath])

  useEffect(() => {
    if (timelineTarget) return

    if (decisionThreads[0]) {
      setTimelineTarget({
        type: 'decision_thread',
        id: decisionThreads[0].id,
        label: decisionThreads[0].title,
      })
      return
    }

    if (commitments[0]) {
      setTimelineTarget({
        type: 'commitment',
        id: commitments[0].id,
        label: commitments[0].title,
      })
      return
    }

    if (entities[0]) {
      setTimelineTarget({
        type: 'entity',
        id: entities[0].id,
        label: entities[0].name,
      })
    }
  }, [timelineTarget, commitments, decisionThreads, entities])

  useEffect(() => {
    if (!timelineTarget) {
      setTimelineResponse(null)
      return
    }

    const target = timelineTarget
    let cancelled = false

    async function loadTimeline() {
      setTimelineLoading(true)
      try {
        const query = target.type === 'decision_thread'
          ? `decision_thread_id=${target.id}`
          : target.type === 'commitment'
            ? `commitment_id=${target.id}`
            : `entity_id=${target.id}`

        const response = await fetch(`/api/agent/timeline?${query}`)
        if (!response.ok) throw new Error('Failed to load timeline')
        const payload = await response.json() as TimelineResponse
        if (!cancelled) {
          setTimelineResponse(payload)
        }
      } catch (loadError) {
        if (!cancelled) {
          setTimelineResponse(null)
        }
      } finally {
        if (!cancelled) {
          setTimelineLoading(false)
        }
      }
    }

    loadTimeline()

    return () => {
      cancelled = true
    }
  }, [timelineTarget])

  const sourceSummary = summarizeArtifactChannels(artifacts.map((artifact) => artifact.channel))

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="relative overflow-hidden rounded-[2rem] border border-border/50 bg-[radial-gradient(circle_at_top_left,rgba(124,58,237,0.14),transparent_38%),radial-gradient(circle_at_top_right,rgba(14,165,233,0.12),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.95),rgba(255,255,255,0.78))] px-6 py-7 shadow-sm dark:bg-[radial-gradient(circle_at_top_left,rgba(124,58,237,0.18),transparent_38%),radial-gradient(circle_at_top_right,rgba(14,165,233,0.14),transparent_30%),linear-gradient(180deg,rgba(25,25,32,0.98),rgba(20,20,27,0.94))]">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/5 px-3 py-1 text-[11px] font-medium tracking-[0.18em] text-primary uppercase">
              <BrainCircuit className="h-3.5 w-3.5" />
              Intelligence Workspace
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
              See the whole memory system, not just the graph.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-[15px]">
              This surface pulls together synced sources, evidence-backed claims, commitments,
              decision threads, generated vault documents, and temporal timelines so you can inspect
              what Axari has actually learned.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm" className="rounded-full">
              <Link href="/command-center">Command Center</Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="rounded-full">
              <Link href="/meetings">Meetings</Link>
            </Button>
            <Button asChild size="sm" className="rounded-full">
              <Link href="/knowledge-graph" className="inline-flex items-center gap-2">
                Knowledge Graph
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {error && (
        <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300">
          {error}
        </div>
      )}

      <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Synced Sources"
          value={stats?.syncedSources ?? 0}
          hint={sourceSummary}
          accent="bg-primary"
        />
        <StatCard
          title="Evidence Items"
          value={stats?.evidenceItems ?? 0}
          hint="Atomic transcript segments, messages, and thread excerpts"
          accent="bg-sky-500"
        />
        <StatCard
          title="Active Claims"
          value={stats?.activeClaims ?? 0}
          hint="Temporal truth currently projected into the graph"
          accent="bg-emerald-500"
        />
        <StatCard
          title="Vault Docs"
          value={stats?.vaultDocs ?? 0}
          hint={`${stats?.openCommitments ?? 0} open commitments · ${stats?.decisionThreads ?? 0} decision threads`}
          accent="bg-violet-500"
        />
      </section>

      <Tabs defaultValue="overview" className="mt-8">
        <TabsList variant="line" className="mb-6">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="vault">Vault</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
            <Card className="overflow-hidden border-border/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <RefreshCw className="h-4 w-4 text-primary" />
                  Source Coverage
                </CardTitle>
                <CardDescription>
                  Connected channels, latest sync run, and the most recent artifacts feeding the evidence graph.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex flex-wrap items-center gap-2">
                  {integrations.length === 0 ? (
                    <Badge variant="secondary">No active integrations</Badge>
                  ) : (
                    integrations.map((integration) => (
                      <Badge key={integration.key} variant="secondary" className="gap-1.5">
                        <span className={`h-1.5 w-1.5 rounded-full ${integration.health_status === 'healthy' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                        {integration.key}
                      </Badge>
                    ))
                  )}
                </div>

                <div className="rounded-2xl border border-border/50 bg-muted/25 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">Daily evidence sync</p>
                      <p className="text-xs text-muted-foreground">
                        {latestSyncRun
                          ? `${String(latestSyncRun.status ?? 'unknown')} · ${timeAgo(String(latestSyncRun.created_at ?? ''))}`
                          : 'No daily sync runs recorded yet'}
                      </p>
                    </div>
                    <Badge variant="outline">
                      {latestSyncRun && typeof latestSyncRun.duration_ms === 'number'
                        ? `${Math.round(Number(latestSyncRun.duration_ms) / 1000)}s`
                        : 'Awaiting run'}
                    </Badge>
                  </div>
                </div>

                <div className="space-y-2">
                  {loading ? (
                    Array.from({ length: 4 }).map((_, index) => (
                      <div key={index} className="h-16 animate-pulse rounded-xl bg-muted/40" />
                    ))
                  ) : artifacts.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
                      No source artifacts yet. New meetings, emails, Slack threads, and chats will appear here.
                    </div>
                  ) : (
                    artifacts.map((artifact) => {
                      const meta = CHANNEL_META[artifact.channel]
                      const Icon = meta.icon
                      const meetingId = typeof artifact.metadata?.meetingId === 'string'
                        ? artifact.metadata.meetingId
                        : null

                      return (
                        <div key={artifact.id} className="rounded-2xl border border-border/50 bg-card/80 p-4">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${meta.badge}`}>
                                  <Icon className="h-3.5 w-3.5" />
                                  {meta.label}
                                </span>
                                <span className="text-[11px] text-muted-foreground">{timeAgo(artifact.created_at)}</span>
                              </div>
                              <p className="mt-2 truncate text-sm font-medium">{artifact.title}</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {formatDateTime(artifact.started_at ?? artifact.created_at)}
                              </p>
                            </div>

                            <div className="flex items-center gap-2">
                              <Badge variant="secondary">{artifact.evidenceCount} evidence</Badge>
                              <Badge variant="secondary">{artifact.claimCount} claims</Badge>
                              {meetingId && (
                                <Button asChild variant="ghost" size="sm" className="h-8 rounded-full px-3 text-xs">
                                  <Link href={`/meetings/${meetingId}`}>Open</Link>
                                </Button>
                              )}
                              {!meetingId && artifact.source_url && (
                                <Button asChild variant="ghost" size="sm" className="h-8 rounded-full px-3 text-xs">
                                  <a href={artifact.source_url} target="_blank" rel="noreferrer">Source</a>
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card className="border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <GitBranch className="h-4 w-4 text-cyan-500" />
                    Canonical Work State
                  </CardTitle>
                  <CardDescription>
                    Current commitments, decision threads, narrative memory, and institutional memory.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Commitments</p>
                      <Badge variant="outline">{stats?.openCommitments ?? 0}</Badge>
                    </div>
                    <div className="space-y-2">
                      {commitments.slice(0, 4).map((commitment) => (
                        <button
                          key={commitment.id}
                          onClick={() => setTimelineTarget({ type: 'commitment', id: commitment.id, label: commitment.title })}
                          className="w-full rounded-xl border border-border/40 bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-medium">{commitment.title}</p>
                            <Badge
                              variant="secondary"
                              className={COMMITMENT_STATUS_BADGES[commitment.status] ?? 'bg-muted text-muted-foreground'}
                            >
                              {commitment.status.replace(/_/g, ' ')}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {commitment.due_date ? `Due ${commitment.due_date}` : 'No due date'} · {timeAgo(commitment.updated_at)}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>

                  <Separator />

                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Decision Threads</p>
                      <Badge variant="outline">{stats?.decisionThreads ?? 0}</Badge>
                    </div>
                    <div className="space-y-2">
                      {decisionThreads.slice(0, 4).map((thread) => (
                        <button
                          key={thread.id}
                          onClick={() => setTimelineTarget({ type: 'decision_thread', id: thread.id, label: thread.title })}
                          className="w-full rounded-xl border border-border/40 bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
                        >
                          <p className="truncate text-sm font-medium">{thread.title}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {thread.status} · {thread.related_entity_ids?.length ?? 0} linked entities · {timeAgo(thread.updated_at)}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>

                  <Separator />

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Narratives</p>
                        <Badge variant="outline">{stats?.narratives ?? 0}</Badge>
                      </div>
                      <div className="space-y-2">
                        {narratives.slice(0, 3).map((narrative) => (
                          <div key={narrative.id} className="rounded-xl border border-border/40 bg-muted/20 px-3 py-2.5">
                            <p className="truncate text-sm font-medium">{narrative.title}</p>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{narrative.summary}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Memories</p>
                        <Badge variant="outline">{stats?.memories ?? 0}</Badge>
                      </div>
                      <div className="space-y-2">
                        {memories.slice(0, 3).map((memory) => (
                          <div key={memory.id} className="rounded-xl border border-border/40 bg-muted/20 px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium">{memory.subject}</p>
                              <Badge variant="secondary" className="text-[10px]">
                                {memory.category.replace(/_/g, ' ')}
                              </Badge>
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{memory.content}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Sparkles className="h-4 w-4 text-violet-500" />
                    Surface Map
                  </CardTitle>
                  <CardDescription>
                    Quick routes into the major product surfaces now connected to the evidence graph.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {[
                    { href: '/knowledge-graph', label: 'Knowledge Graph', detail: 'Interactive entity + relationship canvas', icon: Network },
                    { href: '/command-center', label: 'Command Center', detail: 'Outcomes, cron activity, and execution feeds', icon: BrainCircuit },
                    { href: '/meetings', label: 'Meetings', detail: 'Summaries, transcripts, canonical links, and reprocessing', icon: Video },
                    { href: '/integrations', label: 'Integrations', detail: 'Slack, email, calendar, and meeting providers', icon: RefreshCw },
                  ].map((item) => {
                    const Icon = item.icon
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className="group flex items-center justify-between rounded-xl border border-border/40 bg-muted/20 px-3 py-3 transition-colors hover:bg-muted/40"
                      >
                        <div className="flex items-center gap-3">
                          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <Icon className="h-4 w-4" />
                          </span>
                          <div>
                            <p className="text-sm font-medium">{item.label}</p>
                            <p className="text-xs text-muted-foreground">{item.detail}</p>
                          </div>
                        </div>
                        <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    )
                  })}
                </CardContent>
              </Card>
            </div>
          </div>

          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BrainCircuit className="h-4 w-4 text-primary" />
                Automation & Agent Activity
              </CardTitle>
              <CardDescription>
                Existing command-center activity embedded here so you can inspect outcomes, cron jobs, and evidence pipeline behavior in one place.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AIActivityView />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="vault">
          <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FolderTree className="h-4 w-4 text-sky-500" />
                  Generated Vault
                </CardTitle>
                <CardDescription>
                  Foldered, readable projections over the evidence graph and temporal claims.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-3">
                <ScrollArea className="h-[70vh] pr-3">
                  {vaultTree.length === 0 ? (
                    <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                      Vault documents will appear here after evidence runs regenerate the workspace.
                    </div>
                  ) : (
                    <VaultTreeBranch
                      nodes={vaultTree}
                      selectedPath={selectedVaultPath}
                      expandedFolders={expandedFolders}
                      onToggleFolder={(path) => {
                        setExpandedFolders((current) => {
                          const next = new Set(current)
                          if (next.has(path)) next.delete(path)
                          else next.add(path)
                          return next
                        })
                      }}
                      onSelectDocument={setSelectedVaultPath}
                    />
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <BookOpen className="h-4 w-4 text-violet-500" />
                  Document Preview
                </CardTitle>
                <CardDescription>
                  Human-readable notes generated from source artifacts, claims, decisions, commitments, and timelines.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                {vaultLoading ? (
                  <div className="px-6 py-12 text-sm text-muted-foreground">Loading document…</div>
                ) : !vaultDocument ? (
                  <div className="px-6 py-12 text-sm text-muted-foreground">Select a document from the vault tree.</div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2 px-6">
                      <Badge variant="secondary">{vaultDocument.document.document_type.replace(/_/g, ' ')}</Badge>
                      <Badge variant="outline">{vaultDocument.document.source_mode}</Badge>
                      <Badge variant="outline">{vaultDocument.links.length} links</Badge>
                      <span className="text-xs text-muted-foreground">{vaultDocument.document.path}</span>
                    </div>
                    <Separator />
                    <ScrollArea className="h-[62vh] px-6">
                      <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:tracking-tight prose-p:text-sm prose-li:text-sm">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {vaultDocument.document.content_markdown}
                        </ReactMarkdown>
                      </div>
                    </ScrollArea>
                    {vaultDocument.links.length > 0 && (
                      <>
                        <Separator />
                        <div className="px-6 pb-6">
                          <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                            Linked Objects
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {vaultDocument.links.slice(0, 16).map((link) => (
                              <Badge key={`${link.link_kind}-${link.target_id}`} variant="secondary" className="text-[10px]">
                                {link.link_kind.replace(/_/g, ' ')}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="timeline">
          <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock3 className="h-4 w-4 text-emerald-500" />
                  Timeline Targets
                </CardTitle>
                <CardDescription>
                  Inspect how decisions, commitments, and entities evolve over time in the evidence-backed system.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Decision Threads</p>
                  <div className="space-y-2">
                    {decisionThreads.slice(0, 6).map((thread) => (
                      <button
                        key={thread.id}
                        onClick={() => setTimelineTarget({ type: 'decision_thread', id: thread.id, label: thread.title })}
                        className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                          timelineTarget?.type === 'decision_thread' && timelineTarget.id === thread.id
                            ? 'border-primary/40 bg-primary/5'
                            : 'border-border/40 bg-muted/20 hover:bg-muted/40'
                        }`}
                      >
                        <p className="truncate text-sm font-medium">{thread.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{thread.status} · {timeAgo(thread.updated_at)}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Commitments</p>
                  <div className="space-y-2">
                    {commitments.slice(0, 6).map((commitment) => (
                      <button
                        key={commitment.id}
                        onClick={() => setTimelineTarget({ type: 'commitment', id: commitment.id, label: commitment.title })}
                        className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                          timelineTarget?.type === 'commitment' && timelineTarget.id === commitment.id
                            ? 'border-primary/40 bg-primary/5'
                            : 'border-border/40 bg-muted/20 hover:bg-muted/40'
                        }`}
                      >
                        <p className="truncate text-sm font-medium">{commitment.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{commitment.status.replace(/_/g, ' ')} · {timeAgo(commitment.updated_at)}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Entities</p>
                  <div className="space-y-2">
                    {entities.slice(0, 6).map((entity) => (
                      <button
                        key={entity.id}
                        onClick={() => setTimelineTarget({ type: 'entity', id: entity.id, label: entity.name })}
                        className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                          timelineTarget?.type === 'entity' && timelineTarget.id === entity.id
                            ? 'border-primary/40 bg-primary/5'
                            : 'border-border/40 bg-muted/20 hover:bg-muted/40'
                        }`}
                      >
                        <p className="truncate text-sm font-medium">{entity.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{entity.entity_type} · {timeAgo(entity.updated_at)}</p>
                      </button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <GitBranch className="h-4 w-4 text-cyan-500" />
                  {timelineTarget ? timelineTarget.label : 'Timeline'}
                </CardTitle>
                <CardDescription>
                  Ordered claim history from the temporal truth layer.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {timelineLoading ? (
                  <div className="py-12 text-sm text-muted-foreground">Loading timeline…</div>
                ) : !timelineResponse ? (
                  <div className="py-12 text-sm text-muted-foreground">Select a target to inspect its timeline.</div>
                ) : timelineResponse.timeline.length === 0 ? (
                  <div className="py-12 text-sm text-muted-foreground">
                    No claim history available for this target yet.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {timelineResponse.timeline.map((claim, index) => (
                      <div key={String(claim.id ?? index)} className="relative rounded-2xl border border-border/50 bg-card/80 p-4">
                        <div className="absolute left-4 top-5 h-2.5 w-2.5 rounded-full bg-primary" />
                        {index < timelineResponse.timeline.length - 1 && (
                          <span className="absolute left-[1.18rem] top-8 h-[calc(100%+0.75rem)] w-px bg-border" />
                        )}
                        <div className="pl-6">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="secondary">{String(claim.claim_kind ?? 'claim').replace(/_/g, ' ')}</Badge>
                            {typeof claim.status === 'string' && (
                              <Badge variant="outline">{claim.status}</Badge>
                            )}
                            {typeof claim.evidence_status === 'string' && (
                              <Badge variant="outline">{claim.evidence_status}</Badge>
                            )}
                          </div>
                          <p className="mt-2 text-sm font-medium">{formatClaimLabel(claim)}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatDateTime(
                              typeof claim.valid_from === 'string'
                                ? claim.valid_from
                                : typeof claim.created_at === 'string'
                                  ? claim.created_at
                                  : null
                            )}
                          </p>
                          {typeof claim.object_value === 'string' && claim.object_value.length > 0 && (
                            <p className="mt-2 text-sm text-muted-foreground">{claim.object_value}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
