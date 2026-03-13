'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  CalendarDays,
  FileClock,
  FolderTree,
  History,
  Link2,
  NotebookPen,
  RefreshCw,
  Sparkles,
  Workflow,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { DailyView } from '@/components/command-center/daily-view'
import { createClient } from '@/lib/supabase/client'
import { type VaultTreeNode } from '@/lib/evidence/vault'
import {
  dedupeEntryPoints,
  explainInitiativePriority,
  findRelatedDocsForInitiative,
  describeInitiativeState,
  groupEntryPointsByFreshness,
  labelDocumentType,
  prioritizeInitiatives,
  type IntelligenceInitiativeEntry,
  type IntelligenceVaultEntryPoint,
} from '@/lib/evidence/intelligence-ui'

interface WorkspaceStats {
  vaultDocs: number
  claims: number
  commitments: number
  narratives: number
  initiatives: number
}

interface VaultTreeResponse {
  tree: VaultTreeNode[]
  total: number
  entryPoints: {
    accounts: IntelligenceVaultEntryPoint[]
    relationships: IntelligenceVaultEntryPoint[]
    meetings: IntelligenceVaultEntryPoint[]
    work: IntelligenceVaultEntryPoint[]
    jumpBackIn: IntelligenceVaultEntryPoint[]
    recentlyChanged: IntelligenceVaultEntryPoint[]
  }
}

interface VaultDocumentPayload {
  document: {
    id: string
    path: string
    title: string
    document_type: string
    render_strategy: string
    sections: Array<{
      id: string
      title: string
      kind: string
      content: string
      citations?: Array<{
        label: string
        targetId?: string | null
        path?: string | null
      }>
    }>
    manual_sections: Record<string, {
      key: string
      title: string
      content: string
      updatedAt?: string | null
    }>
    source_mode: string
    staleness_reason: string | null
    last_source_update_at: string | null
  }
  links: Array<{
    linkKind: string
    targetId: string
    targetLabel: string | null
    targetPath: string | null
    targetType: string | null
  }>
  backlinks: Array<{
    documentId: string
    path: string
    title: string
    documentType: string
    updatedAt: string
  }>
  freshness: {
    stalenessReason: string | null
    lastSourceUpdateAt: string | null
    updatedAt: string | null
  }
  compare: {
    previousSummary: string | null
  }
}

interface ChangesResponse {
  changes: Array<{
    id: string
    path: string
    title: string
    document_type: string
    render_strategy: string
    updated_at: string
    last_source_update_at: string | null
    staleness_reason: string | null
  }>
}

interface ChiefWorldModelPayload {
  operationalMemory?: {
    urgentCommitments?: Array<{ title: string; status: string }>
    blockedInitiatives?: Array<{ title: string; reason: string }>
  } | null
}

type WorkspacePanel = 'today' | 'initiatives' | 'accounts' | 'meetings' | 'work' | 'raw'

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Unknown'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
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

function SidebarEntryList({
  title,
  entries,
  selectedPath,
  onSelect,
}: {
  title: string
  entries: IntelligenceVaultEntryPoint[]
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  if (entries.length === 0) return null

  return (
    <div>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{title}</p>
      <div className="space-y-1.5">
        {entries.map((entry) => (
          <button
            key={entry.path}
            onClick={() => onSelect(entry.path)}
            className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
              entry.path === selectedPath
                ? 'border-primary/40 bg-primary/5'
                : 'border-border/50 bg-card/80 hover:bg-muted/40'
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="truncate text-sm font-medium">{entry.title}</p>
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {labelDocumentType(entry.documentType)}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{timeAgo(entry.updatedAt)}</p>
          </button>
        ))}
      </div>
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
  nodes: VaultTreeNode[]
  selectedPath: string | null
  expandedFolders: Set<string>
  onToggleFolder: (path: string) => void
  onSelectDocument: (path: string) => void
}) {
  return (
    <ul className="space-y-1">
      {nodes.map((node) => {
        if (node.type === 'document') {
          return (
            <li key={node.path}>
              <button
                onClick={() => onSelectDocument(node.path)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  node.path === selectedPath
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

function HomeSection({
  title,
  subtitle,
  entries,
  onOpen,
}: {
  title: string
  subtitle: string
  entries: IntelligenceVaultEntryPoint[]
  onOpen: (path: string) => void
}) {
  return (
    <Card className="border-border/50">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold">{title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <Badge variant="secondary">{entries.length}</Badge>
        </div>
        <div className="mt-4 space-y-2">
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing here yet.</p>
          ) : (
            entries.slice(0, 5).map((entry) => (
              <button
                key={entry.path}
                onClick={() => onOpen(entry.path)}
                className="flex w-full items-center justify-between rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{entry.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {labelDocumentType(entry.documentType)} · {timeAgo(entry.updatedAt)}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function IntelligenceHome({
  jumpBackIn,
  recentlyChanged,
  meetings,
  work,
  initiatives,
  onOpenDocument,
  onOpenInitiative,
}: {
  jumpBackIn: IntelligenceVaultEntryPoint[]
  recentlyChanged: IntelligenceVaultEntryPoint[]
  meetings: IntelligenceVaultEntryPoint[]
  work: IntelligenceVaultEntryPoint[]
  initiatives: IntelligenceInitiativeEntry[]
  onOpenDocument: (path: string) => void
  onOpenInitiative: (initiativeId: string) => void
}) {
  return (
    <div className="space-y-6 p-6">
      <Card className="border-primary/15 bg-primary/[0.03] shadow-none">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold tracking-tight">Start here</h2>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Intelligence is now the main workspace. Use it to answer three questions fast:
                what changed, what needs attention, and where the latest context came from.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <HomeSection
          title="Initiatives"
          subtitle="Long-horizon work the chief is actively tracking."
          entries={initiatives.slice(0, 5).map((initiative) => ({
            path: `initiative:${initiative.id}`,
            title: initiative.title,
            documentType: 'initiative',
            updatedAt: initiative.lastSignalAt ?? initiative.nextReviewAt ?? new Date().toISOString(),
            lastSourceUpdateAt: initiative.lastSignalAt,
          }))}
          onOpen={(path) => onOpenInitiative(path.replace('initiative:', ''))}
        />
        <HomeSection
          title="Jump back in"
          subtitle="The most useful briefs and narratives to resume work quickly."
          entries={jumpBackIn}
          onOpen={onOpenDocument}
        />
        <HomeSection
          title="Recently changed"
          subtitle="Freshly updated docs across meetings, work, and knowledge."
          entries={recentlyChanged}
          onOpen={onOpenDocument}
        />
        <HomeSection
          title="Recent meetings"
          subtitle="Meeting source docs and notes worth reviewing."
          entries={meetings}
          onOpen={onOpenDocument}
        />
        <HomeSection
          title="Work in motion"
          subtitle="Action items, decisions, and briefs that deserve follow-up."
          entries={work}
          onOpen={onOpenDocument}
        />
      </div>

      <Card className="border-border/50">
        <CardContent className="p-6">
          <div className="mb-5">
            <h3 className="text-base font-semibold">Today</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              This replaces the old Command Center feed with the pieces that are actually useful.
            </p>
          </div>
          <DailyView />
        </CardContent>
      </Card>
    </div>
  )
}

export function IntelligenceWorkspace() {
  const supabase = useMemo(() => createClient() as any, [])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<WorkspaceStats | null>(null)
  const [tree, setTree] = useState<VaultTreeNode[]>([])
  const [entryPoints, setEntryPoints] = useState<VaultTreeResponse['entryPoints'] | null>(null)
  const [changes, setChanges] = useState<ChangesResponse['changes']>([])
  const [initiatives, setInitiatives] = useState<IntelligenceInitiativeEntry[]>([])
  const [selectedInitiativeId, setSelectedInitiativeId] = useState<string | null>(null)
  const [chiefWorldModel, setChiefWorldModel] = useState<ChiefWorldModelPayload | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [document, setDocument] = useState<VaultDocumentPayload | null>(null)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [selectedPanel, setSelectedPanel] = useState<WorkspacePanel>('today')
  const [manualDrafts, setManualDrafts] = useState<Record<string, string>>({})
  const [savingSectionKey, setSavingSectionKey] = useState<string | null>(null)

  function openDocument(path: string) {
    setSelectedInitiativeId(null)
    setSelectedPath(path)
  }

  useEffect(() => {
    let cancelled = false

    async function loadWorkspace() {
      setLoading(true)
      setError(null)

      try {
        const [
          treeRes,
          changesRes,
          initiativesRes,
          worldModelRes,
          vaultDocsCountRes,
          claimsCountRes,
          commitmentsCountRes,
          narrativesCountRes,
          initiativesCountRes,
        ] = await Promise.all([
          fetch('/api/vault/tree').then(async (response) => {
            if (!response.ok) throw new Error('Failed to load vault tree')
            return response.json() as Promise<VaultTreeResponse>
          }),
          fetch('/api/vault/changes').then(async (response) => {
            if (!response.ok) throw new Error('Failed to load vault changes')
            return response.json() as Promise<ChangesResponse>
          }),
          supabase
            .from('initiatives')
            .select('id, title, status, phase, next_milestone, next_review_at, last_signal_at, latest_summary, open_questions, known_risks')
            .in('status', ['active', 'waiting', 'blocked'])
            .order('updated_at', { ascending: false }),
          supabase
            .from('chief_world_model')
            .select('operational_memory')
            .maybeSingle(),
          supabase.from('vault_documents').select('id', { count: 'exact', head: true }),
          supabase.from('claims').select('id', { count: 'exact', head: true }).eq('status', 'active'),
          supabase.from('commitments').select('id', { count: 'exact', head: true }).in('status', ['active', 'at_risk', 'overdue']),
          supabase.from('vault_documents').select('id', { count: 'exact', head: true }).eq('document_type', 'narrative'),
          supabase.from('initiatives').select('id', { count: 'exact', head: true }).in('status', ['active', 'waiting', 'blocked']),
        ])

        if (!cancelled) {
          setTree(treeRes.tree)
          setEntryPoints({
            accounts: dedupeEntryPoints(treeRes.entryPoints.accounts),
            relationships: dedupeEntryPoints(treeRes.entryPoints.relationships),
            meetings: dedupeEntryPoints(treeRes.entryPoints.meetings),
            work: dedupeEntryPoints(treeRes.entryPoints.work),
            jumpBackIn: dedupeEntryPoints(treeRes.entryPoints.jumpBackIn),
            recentlyChanged: dedupeEntryPoints(treeRes.entryPoints.recentlyChanged),
          })
          setChanges(changesRes.changes)
          setInitiatives(prioritizeInitiatives(
            ((initiativesRes.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
              id: String(row.id ?? ''),
              title: String(row.title ?? ''),
              status: String(row.status ?? 'active'),
              phase: String(row.phase ?? 'discovery'),
              nextMilestone: typeof row.next_milestone === 'string' ? row.next_milestone : null,
              nextReviewAt: typeof row.next_review_at === 'string' ? row.next_review_at : null,
              lastSignalAt: typeof row.last_signal_at === 'string' ? row.last_signal_at : null,
              latestSummary: typeof row.latest_summary === 'string' ? row.latest_summary : null,
              openQuestionCount: Array.isArray(row.open_questions) ? row.open_questions.length : 0,
              riskCount: Array.isArray(row.known_risks) ? row.known_risks.length : 0,
            }))
          ))
          setChiefWorldModel((worldModelRes.data?.operational_memory ?? null) ? {
            operationalMemory: worldModelRes.data?.operational_memory as ChiefWorldModelPayload['operationalMemory'],
          } : null)
          setExpandedFolders(new Set(treeRes.tree.map((node) => node.path)))
          setStats({
            vaultDocs: vaultDocsCountRes.count ?? 0,
            claims: claimsCountRes.count ?? 0,
            commitments: commitmentsCountRes.count ?? 0,
            narratives: narrativesCountRes.count ?? 0,
            initiatives: initiativesCountRes.count ?? 0,
          })
        }
      } catch (loadError) {
        if (!cancelled) {
          const message = loadError instanceof Error ? loadError.message : 'Failed to load vault workspace'
          setError(message)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadWorkspace()
    return () => {
      cancelled = true
    }
  }, [supabase])

  useEffect(() => {
    if (!selectedPath) {
      setDocument(null)
      return
    }

    let cancelled = false
    const path = selectedPath

    async function loadDocument() {
      const response = await fetch(`/api/vault/document?path=${encodeURIComponent(path)}`)
      if (!response.ok) {
        if (!cancelled) setDocument(null)
        return
      }

      const payload = await response.json() as VaultDocumentPayload
      if (!cancelled) {
        setDocument(payload)
        setManualDrafts(
          Object.fromEntries(
            Object.entries(payload.document.manual_sections ?? {}).map(([key, section]) => [key, section.content ?? ''])
          )
        )
      }
    }

    loadDocument()
    return () => {
      cancelled = true
    }
  }, [selectedPath])

  const groupedAccounts = useMemo(
    () => groupEntryPointsByFreshness(entryPoints?.accounts ?? []),
    [entryPoints]
  )

  const allVaultDocs = useMemo(
    () => dedupeEntryPoints([
      ...(entryPoints?.accounts ?? []),
      ...(entryPoints?.relationships ?? []),
      ...(entryPoints?.meetings ?? []),
      ...(entryPoints?.work ?? []),
      ...(entryPoints?.jumpBackIn ?? []),
      ...(entryPoints?.recentlyChanged ?? []),
    ]),
    [entryPoints]
  )

  const linkedWork = useMemo(
    () => (document?.links ?? []).filter((link) => ['commitment', 'decision_thread'].includes(link.linkKind)),
    [document]
  )

  const linkedContext = useMemo(
    () => (document?.links ?? []).filter((link) => !['commitment', 'decision_thread'].includes(link.linkKind)),
    [document]
  )

  const citedSources = useMemo(() => {
    const labels = new Set<string>()
    const items: string[] = []

    for (const section of document?.document.sections ?? []) {
      for (const citation of section.citations ?? []) {
        if (labels.has(citation.label)) continue
        labels.add(citation.label)
        items.push(citation.label)
      }
    }

    return items
  }, [document])

  const selectedInitiative = useMemo(
    () => initiatives.find((initiative) => initiative.id === selectedInitiativeId) ?? null,
    [initiatives, selectedInitiativeId]
  )

  const initiativeRelatedDocs = useMemo(
    () => selectedInitiative ? findRelatedDocsForInitiative(selectedInitiative, allVaultDocs) : [],
    [allVaultDocs, selectedInitiative]
  )

  async function saveManualSection(key: string) {
    if (!document) return
    setSavingSectionKey(key)

    try {
      const section = document.document.manual_sections[key]
      const response = await fetch('/api/vault/document/manual-section', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: document.document.path,
          key,
          title: section?.title ?? key.replace(/_/g, ' '),
          content: manualDrafts[key] ?? '',
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to save manual section')
      }

      const refreshed = await fetch(`/api/vault/document?path=${encodeURIComponent(document.document.path)}`)
      if (!refreshed.ok) throw new Error('Failed to refresh document')
      const payload = await refreshed.json() as VaultDocumentPayload
      setDocument(payload)
      setManualDrafts(
        Object.fromEntries(
          Object.entries(payload.document.manual_sections ?? {}).map(([draftKey, manualSection]) => [draftKey, manualSection.content ?? ''])
        )
      )
    } finally {
      setSavingSectionKey(null)
    }
  }

  const leftRailContent = (() => {
    switch (selectedPanel) {
      case 'initiatives':
        return (
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Active initiatives</p>
            <div className="space-y-1.5">
              {initiatives.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active initiatives yet.</p>
              ) : (
                initiatives.map((initiative) => (
                  <button
                    key={initiative.id}
                    onClick={() => {
                      setSelectedInitiativeId(initiative.id)
                      setSelectedPath(null)
                    }}
                    className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                      selectedInitiativeId === initiative.id
                        ? 'border-primary/40 bg-primary/5'
                        : 'border-border/50 bg-card/80 hover:bg-muted/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-sm font-medium">{initiative.title}</p>
                      <Badge variant="secondary" className="text-[10px]">
                        {initiative.phase}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{describeInitiativeState(initiative)}</p>
                  </button>
                ))
              )}
            </div>
          </div>
        )
      case 'accounts':
        return (
          <>
            <SidebarEntryList
              title="Fresh account docs"
              entries={groupedAccounts.fresh}
              selectedPath={selectedPath}
              onSelect={openDocument}
            />
            <SidebarEntryList
              title="Relationship docs"
              entries={entryPoints?.relationships ?? []}
              selectedPath={selectedPath}
              onSelect={openDocument}
            />
            <SidebarEntryList
              title="Older account docs"
              entries={groupedAccounts.older}
              selectedPath={selectedPath}
              onSelect={openDocument}
            />
          </>
        )
      case 'meetings':
        return (
          <SidebarEntryList
            title="Meeting docs"
            entries={entryPoints?.meetings ?? []}
            selectedPath={selectedPath}
            onSelect={openDocument}
          />
        )
      case 'work':
        return (
          <SidebarEntryList
            title="Action items, decisions & briefs"
            entries={entryPoints?.work ?? []}
            selectedPath={selectedPath}
            onSelect={openDocument}
          />
        )
      case 'raw':
        return tree.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-muted-foreground">
            Vault documents will appear here after evidence runs regenerate the workspace.
          </div>
        ) : (
          <VaultTreeBranch
            nodes={tree}
            selectedPath={selectedPath}
            expandedFolders={expandedFolders}
            onToggleFolder={(path) => {
              setExpandedFolders((current) => {
                const next = new Set(current)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })
            }}
            onSelectDocument={openDocument}
          />
        )
      case 'today':
      default:
        return (
          <>
            <SidebarEntryList
              title="Jump back in"
              entries={entryPoints?.jumpBackIn ?? []}
              selectedPath={selectedPath}
              onSelect={openDocument}
            />
            <SidebarEntryList
              title="Recent movement"
              entries={entryPoints?.recentlyChanged ?? []}
              selectedPath={selectedPath}
              onSelect={openDocument}
            />
          </>
        )
    }
  })()

  const showHome = !selectedPath && !selectedInitiative

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-8 sm:px-6 sm:py-10">
      <header className="rounded-[2rem] border border-border/50 bg-card/90 px-6 py-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/5 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
              <NotebookPen className="h-3.5 w-3.5" />
              Intelligence
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
              One place to understand what matters now.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-[15px]">
              Start with today, then drill into accounts, meetings, and work. The graph stays underneath, but this page should feel like your operating workspace instead of a debug console.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Vault docs', value: stats?.vaultDocs ?? 0, icon: BookOpen },
                { label: 'Active claims', value: stats?.claims ?? 0, icon: Workflow },
                { label: 'Initiatives', value: stats?.initiatives ?? 0, icon: BrainCircuit },
                { label: 'Open work', value: stats?.commitments ?? 0, icon: RefreshCw },
              ].map((stat) => {
              const Icon = stat.icon
              return (
                <div key={stat.label} className="rounded-2xl border border-border/50 bg-muted/20 px-4 py-3">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" />
                    {stat.label}
                  </div>
                  <p className="mt-2 text-2xl font-semibold">{stat.value}</p>
                </div>
              )
            })}
          </div>
        </div>
      </header>

      {error && (
        <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)_320px]">
        <Card className="border-border/50">
          <CardContent className="p-4">
            <div className="flex flex-wrap gap-2">
              {[
                ['today', 'Today'],
                ['initiatives', 'Initiatives'],
                ['accounts', 'Accounts'],
                ['meetings', 'Meetings'],
                ['work', 'Work'],
                ['raw', 'Raw vault'],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  variant={selectedPanel === value ? 'default' : 'outline'}
                  size="sm"
                  className="rounded-full"
                  onClick={() => {
                    setSelectedPanel(value as WorkspacePanel)
                    if (value === 'today') {
                      setSelectedPath(null)
                      setSelectedInitiativeId(null)
                    }
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>

            <ScrollArea className="mt-4 h-[72vh] pr-3">
              <div className="space-y-6">{leftRailContent}</div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="border-border/50">
          <CardContent className="p-0">
            <ScrollArea className="h-[78vh]">
              {loading ? (
                <div className="flex h-[78vh] items-center justify-center text-sm text-muted-foreground">
                  Loading intelligence workspace…
                </div>
              ) : showHome ? (
                <IntelligenceHome
                  jumpBackIn={entryPoints?.jumpBackIn ?? []}
                  recentlyChanged={entryPoints?.recentlyChanged ?? []}
                  meetings={entryPoints?.meetings ?? []}
                  work={entryPoints?.work ?? []}
                  initiatives={initiatives}
                  onOpenDocument={openDocument}
                  onOpenInitiative={(initiativeId) => {
                    setSelectedPanel('initiatives')
                    setSelectedPath(null)
                    setSelectedInitiativeId(initiativeId)
                  }}
                />
              ) : selectedInitiative ? (
                <div className="p-6">
                  <div className="flex flex-col gap-3 border-b border-border/50 pb-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">Initiative</Badge>
                      <Badge variant="outline">{selectedInitiative.phase}</Badge>
                      <Badge variant="outline">{selectedInitiative.status}</Badge>
                    </div>
                    <h2 className="text-2xl font-semibold tracking-tight">{selectedInitiative.title}</h2>
                    <p className="text-sm text-muted-foreground">{describeInitiativeState(selectedInitiative)}</p>
                  </div>

                  <div className="mt-6 rounded-2xl border border-border/50 bg-muted/20 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <History className="h-4 w-4 text-primary" />
                      Why this is prioritized
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {explainInitiativePriority(selectedInitiative)}
                    </p>
                  </div>

                  <div className="mt-6 grid gap-4 md:grid-cols-2">
                    <section className="rounded-2xl border border-border/50 p-4">
                      <h3 className="text-base font-medium">Current state</h3>
                      <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
                        {selectedInitiative.latestSummary ?? 'No initiative summary yet. The chief will fill this in as signals accumulate.'}
                      </p>
                    </section>
                    <section className="rounded-2xl border border-border/50 p-4">
                      <h3 className="text-base font-medium">Next review</h3>
                      <p className="mt-3 text-sm text-muted-foreground">
                        {selectedInitiative.nextReviewAt ? formatDateTime(selectedInitiative.nextReviewAt) : 'No review scheduled'}
                      </p>
                      <div className="mt-4">
                        <h4 className="text-sm font-medium">Next milestone</h4>
                        <p className="mt-2 text-sm text-muted-foreground">
                          {selectedInitiative.nextMilestone ?? 'No milestone set yet'}
                        </p>
                      </div>
                    </section>
                    <section className="rounded-2xl border border-border/50 p-4">
                      <h3 className="text-base font-medium">Related vault docs</h3>
                      <div className="mt-3 space-y-2">
                        {initiativeRelatedDocs.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No related docs linked yet.</p>
                        ) : (
                          initiativeRelatedDocs.map((doc) => (
                            <button
                              key={doc.path}
                              onClick={() => openDocument(doc.path)}
                              className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                            >
                              <p className="truncate text-sm font-medium">{doc.title}</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {labelDocumentType(doc.documentType)} · {timeAgo(doc.updatedAt)}
                              </p>
                            </button>
                          ))
                        )}
                      </div>
                    </section>
                  </div>
                </div>
              ) : !document ? (
                <div className="flex h-[78vh] items-center justify-center text-sm text-muted-foreground">
                  Select a document from the left.
                </div>
              ) : (
                <div className="p-6">
                  <div className="flex flex-col gap-3 border-b border-border/50 pb-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{labelDocumentType(document.document.document_type)}</Badge>
                      <Badge variant="outline">{document.document.render_strategy.replace(/_/g, ' ')}</Badge>
                      <Badge variant="outline">{document.document.source_mode}</Badge>
                    </div>
                    <h2 className="text-2xl font-semibold tracking-tight">{document.document.title}</h2>
                    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                      <span>Updated {formatDateTime(document.freshness.updatedAt)}</span>
                      <span>Source update {formatDateTime(document.freshness.lastSourceUpdateAt)}</span>
                      {document.freshness.stalenessReason && <span>{document.freshness.stalenessReason}</span>}
                    </div>
                  </div>

                  {document.compare.previousSummary && (
                    <div className="mt-6 rounded-2xl border border-border/50 bg-muted/20 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <History className="h-4 w-4 text-primary" />
                        Changed since last update
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                        {document.compare.previousSummary}
                      </p>
                    </div>
                  )}

                  <div className="mt-6 space-y-6">
                    {document.document.sections.map((section) => (
                      <section key={section.id} className="rounded-2xl border border-border/50 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-base font-medium">{section.title}</h3>
                          <Badge variant="outline" className="text-[10px] uppercase">
                            {section.kind}
                          </Badge>
                        </div>
                        <div className="prose prose-sm mt-3 max-w-none dark:prose-invert">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {section.content}
                          </ReactMarkdown>
                        </div>
                        {(section.citations ?? []).length > 0 && (
                          <div className="mt-4 flex flex-wrap gap-2">
                            {section.citations?.map((citation, index) => (
                              <Badge key={`${section.id}-${index}`} variant="secondary" className="gap-1">
                                <FileClock className="h-3 w-3" />
                                {citation.label}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </section>
                    ))}

                    {Object.values(document.document.manual_sections ?? {}).map((section) => (
                      <section key={section.key} className="rounded-2xl border border-border/50 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-base font-medium">{section.title}</h3>
                          <Badge variant="outline">Editable</Badge>
                        </div>
                        <Textarea
                          value={manualDrafts[section.key] ?? ''}
                          onChange={(event) => setManualDrafts((current) => ({
                            ...current,
                            [section.key]: event.target.value,
                          }))}
                          className="mt-3 min-h-[140px]"
                          placeholder={`Add ${section.title.toLowerCase()}…`}
                        />
                        <div className="mt-3 flex justify-end">
                          <Button
                            size="sm"
                            className="rounded-full"
                            onClick={() => saveManualSection(section.key)}
                            disabled={savingSectionKey === section.key}
                          >
                            {savingSectionKey === section.key ? 'Saving…' : 'Save section'}
                          </Button>
                        </div>
                      </section>
                    ))}
                  </div>
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <div className="space-y-6">
          {showHome ? (
            <>
              <Card className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Sparkles className="h-4 w-4 text-primary" />
                    How to use this
                  </div>
                  <div className="mt-4 space-y-3 text-sm text-muted-foreground">
                    <p>Use <span className="font-medium text-foreground">Today</span> for what needs attention now.</p>
                    <p>Use <span className="font-medium text-foreground">Initiatives</span> to track long-horizon work the chief is actively advancing.</p>
                    <p>Use <span className="font-medium text-foreground">Accounts</span> when you want the storyline for a company or relationship.</p>
                    <p>Use <span className="font-medium text-foreground">Meetings</span> for raw meeting source docs and notes.</p>
                    <p>Use <span className="font-medium text-foreground">Work</span> for action items, decisions, and briefs.</p>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <ArrowRight className="h-4 w-4 text-primary" />
                    Useful surfaces
                  </div>
                  <div className="mt-4 grid gap-2">
                    {[
                      { href: '/meetings', label: 'Meetings' },
                      { href: '/knowledge-graph', label: 'Knowledge Graph' },
                      { href: '/integrations', label: 'Integrations' },
                    ].map((item) => (
                      <Button asChild key={item.href} variant="outline" className="justify-between rounded-xl">
                        <Link href={item.href}>
                          {item.label}
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                      </Button>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Workflow className="h-4 w-4 text-primary" />
                    Chief world model
                  </div>
                  <div className="mt-4 space-y-3 text-sm text-muted-foreground">
                    <p>
                      Urgent commitments: {chiefWorldModel?.operationalMemory?.urgentCommitments?.length ?? 0}
                    </p>
                    <p>
                      Blocked initiatives: {chiefWorldModel?.operationalMemory?.blockedInitiatives?.length ?? 0}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <>
              {selectedInitiative && (
                <>
                  <Card className="border-border/50">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Workflow className="h-4 w-4 text-primary" />
                        Changed since last review
                      </div>
                      <p className="mt-4 text-sm text-muted-foreground">
                        {selectedInitiative.latestSummary ?? 'No change summary yet.'}
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="border-border/50">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Link2 className="h-4 w-4 text-primary" />
                        Initiative docs
                      </div>
                      <div className="mt-4 space-y-2">
                        {initiativeRelatedDocs.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No related docs yet.</p>
                        ) : (
                          initiativeRelatedDocs.map((doc) => (
                            <button
                              key={doc.path}
                              onClick={() => openDocument(doc.path)}
                              className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                            >
                              <p className="truncate text-sm font-medium">{doc.title}</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {labelDocumentType(doc.documentType)} · {timeAgo(doc.updatedAt)}
                              </p>
                            </button>
                          ))
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}
              {!selectedInitiative && (
                <>
                  <Card className="border-border/50">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Link2 className="h-4 w-4 text-primary" />
                        Linked context
                      </div>
                      <div className="mt-4 space-y-2">
                        {linkedContext.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No linked context yet.</p>
                        ) : (
                          linkedContext.map((link) => (
                            <button
                              key={`${link.linkKind}-${link.targetId}`}
                              onClick={() => link.targetPath && openDocument(link.targetPath)}
                              className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <p className="truncate text-sm font-medium">{link.targetLabel ?? link.targetId}</p>
                                <Badge variant="secondary" className="text-[10px]">
                                  {link.targetType ?? link.linkKind}
                                </Badge>
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-border/50">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <BrainCircuit className="h-4 w-4 text-primary" />
                        Work connected to this
                      </div>
                      <div className="mt-4 space-y-2">
                        {linkedWork.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No linked action items or decisions yet.</p>
                        ) : (
                          linkedWork.map((link) => (
                            <button
                              key={`${link.linkKind}-${link.targetId}`}
                              onClick={() => link.targetPath && openDocument(link.targetPath)}
                              className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <p className="truncate text-sm font-medium">{link.targetLabel ?? link.targetId}</p>
                                <Badge variant="secondary" className="text-[10px]">
                                  {link.targetType ?? labelDocumentType(link.linkKind)}
                                </Badge>
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border-border/50">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <CalendarDays className="h-4 w-4 text-primary" />
                        Sources used in this doc
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {citedSources.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No source chips yet.</p>
                        ) : (
                          citedSources.map((label) => (
                            <Badge key={label} variant="secondary" className="gap-1">
                              <FileClock className="h-3 w-3" />
                              {label}
                            </Badge>
                          ))
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}

              <Card className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <RefreshCw className="h-4 w-4 text-primary" />
                    Referenced in
                  </div>
                  <div className="mt-4 space-y-2">
                    {(document?.backlinks ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No related docs yet.</p>
                    ) : (
                      document?.backlinks.map((backlink) => (
                        <button
                          key={`${backlink.documentId}-${backlink.path}`}
                          onClick={() => openDocument(backlink.path)}
                          className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                        >
                          <p className="truncate text-sm font-medium">{backlink.title}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {labelDocumentType(backlink.documentType)} · {timeAgo(backlink.updatedAt)}
                          </p>
                        </button>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
