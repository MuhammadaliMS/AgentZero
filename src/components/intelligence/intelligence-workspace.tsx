'use client'

import { useEffect, useMemo, useState } from 'react'
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
  ShieldAlert,
  RefreshCw,
  Sparkles,
  TimerReset,
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
  buildAccountWorkspaceSummary,
  buildEvidenceFeed,
  buildIntelligenceNowSummary,
  describeLikelyNextAction,
  dedupeEntryPoints,
  explainAccountPriority,
  explainInitiativePriority,
  findChangedDocsForInitiative,
  findInitiativesForDocument,
  findRelatedDocsForInitiative,
  describeInitiativeState,
  groupEntryPointsByFreshness,
  labelDocumentType,
  prioritizeInitiatives,
  summarizeInitiativeManualContext,
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
  impactedInitiatives?: Array<{
    id: string
    title: string
    status: string
    phase: string
    nextMilestone: string | null
    latestSummary: string | null
  }>
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

type WorkspacePanel = 'today' | 'initiatives' | 'accounts' | 'evidence' | 'work' | 'raw'

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

function NowList({
  title,
  subtitle,
  icon: Icon,
  items,
  emptyLabel,
  onOpen,
}: {
  title: string
  subtitle: string
  icon: typeof Sparkles
  items: Array<{ title: string; reason: string; supportingPath?: string | null }>
  emptyLabel: string
  onOpen?: (path: string) => void
}) {
  return (
    <Card className="border-border/50">
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-base font-semibold">{title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="mt-4 space-y-2">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{emptyLabel}</p>
          ) : (
            items.map((item) => {
              const content = (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    {item.supportingPath && <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.reason}</p>
                </>
              )

              if (!item.supportingPath || !onOpen) {
                return (
                  <div key={`${item.title}-${item.reason}`} className="rounded-xl border border-border/50 bg-card/80 px-3 py-2">
                    {content}
                  </div>
                )
              }

              return (
                <button
                  key={`${item.title}-${item.reason}`}
                  onClick={() => onOpen(item.supportingPath!)}
                  className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                >
                  {content}
                </button>
              )
            })
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function IntelligenceHome({
  jumpBackIn,
  initiatives,
  nowSummary,
  onOpenDocument,
  onOpenInitiative,
}: {
  jumpBackIn: IntelligenceVaultEntryPoint[]
  initiatives: IntelligenceInitiativeEntry[]
  nowSummary: ReturnType<typeof buildIntelligenceNowSummary>
  onOpenDocument: (path: string) => void
  onOpenInitiative: (initiativeId: string) => void
}) {
  const topPriorities = nowSummary.topPriorities.map((item) => {
    const matching = initiatives.find((initiative) => initiative.title === item.title)
    return {
      ...item,
      supportingPath: matching ? `initiative:${matching.id}` : null,
    }
  })

  return (
    <div className="space-y-6 p-6">
      <Card className="border-primary/15 bg-primary/[0.03] shadow-none">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold tracking-tight">Chief Now</h2>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Open this view to answer five things quickly: what changed, what the chief is prioritizing,
                what needs you, what is blocked, and which evidence caused those decisions.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {[
          {
            label: 'Changed since last check',
            value: nowSummary.whatChanged.length,
            detail: nowSummary.whatChanged[0]?.title ?? 'No new change yet',
          },
          {
            label: 'Top priorities',
            value: nowSummary.topPriorities.length,
            detail: nowSummary.topPriorities[0]?.title ?? 'No active priority yet',
          },
          {
            label: 'Needs you',
            value: nowSummary.needsAttention.length,
            detail: nowSummary.needsAttention[0]?.title ?? 'Nothing urgent for you',
          },
          {
            label: 'Blocked',
            value: nowSummary.blocked.length,
            detail: nowSummary.blocked[0]?.title ?? 'No blocked initiatives',
          },
          {
            label: 'Waiting',
            value: nowSummary.waiting.length,
            detail: nowSummary.waiting[0]?.title ?? 'No waiting items',
          },
        ].map((card) => (
          <Card key={card.label} className="border-border/50">
            <CardContent className="p-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{card.label}</p>
              <p className="mt-2 text-2xl font-semibold">{card.value}</p>
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{card.detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,0.9fr)]">
        <div className="space-y-6">
          <NowList
            title="What changed"
            subtitle="The newest shifts across meetings, work, and account docs."
            icon={RefreshCw}
            items={nowSummary.whatChanged}
            emptyLabel="Nothing material changed since the last check."
            onOpen={onOpenDocument}
          />
          <NowList
            title="What the chief is doing now"
            subtitle="The workstreams currently getting active attention."
            icon={BrainCircuit}
            items={topPriorities}
            emptyLabel="The chief has not raised any active priorities yet."
            onOpen={(path) => {
              if (path.startsWith('initiative:')) {
                onOpenInitiative(path.replace('initiative:', ''))
                return
              }
              onOpenDocument(path)
            }}
          />
          <div className="grid gap-6 lg:grid-cols-2">
            <NowList
              title="What needs your attention"
              subtitle="Questions, risks, and urgent commitments the chief cannot clear alone."
              icon={Sparkles}
              items={nowSummary.needsAttention}
              emptyLabel="Nothing needs your input right now."
              onOpen={onOpenDocument}
            />
            <NowList
              title="What is blocked"
              subtitle="Work that cannot advance until a dependency resolves."
              icon={ShieldAlert}
              items={nowSummary.blocked}
              emptyLabel="No blocked initiatives right now."
            />
          </div>
          <NowList
            title="What is waiting"
            subtitle="Items the chief is monitoring but not actively pushing yet."
            icon={TimerReset}
            items={nowSummary.waiting}
            emptyLabel="Nothing is in a waiting state right now."
          />
        </div>

        <div className="space-y-6">
          <NowList
            title="Why these priorities"
            subtitle="The chief's current reasoning over initiative state and recent signals."
            icon={History}
            items={topPriorities}
            emptyLabel="No active priority reasoning yet."
            onOpen={(path) => {
              if (path.startsWith('initiative:')) {
                onOpenInitiative(path.replace('initiative:', ''))
              }
            }}
          />
          <HomeSection
            title="Evidence used"
            subtitle="The briefs, narratives, and source docs shaping the current world model."
            entries={nowSummary.evidenceUsed}
            onOpen={onOpenDocument}
          />
          <HomeSection
            title="Recent sources"
            subtitle="Meetings and source records that most recently changed the chief's view."
            entries={nowSummary.recentSources}
            onOpen={onOpenDocument}
          />
          <HomeSection
            title="Jump back in"
            subtitle="The fastest briefs and narratives to reopen if you want deeper context."
            entries={jumpBackIn}
            onOpen={onOpenDocument}
          />
        </div>
      </div>

      <Card className="border-border/50">
        <CardContent className="p-6">
          <div className="mb-5">
            <h3 className="text-base font-semibold">Signals and actions</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              The old Command Center feed now lives here, underneath the higher-signal chief summary.
            </p>
          </div>
          <DailyView />
        </CardContent>
      </Card>
    </div>
  )
}

function AccountSpotlight({
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
        <div>
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="mt-4 space-y-2">
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing here yet.</p>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => onOpen(entry.path)}
                className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-3 text-left hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-sm font-medium">{entry.title}</p>
                  <Badge variant="secondary" className="text-[10px]">
                    {labelDocumentType(entry.documentType)}
                  </Badge>
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {entry.summary ?? `${labelDocumentType(entry.documentType)} updated ${timeAgo(entry.updatedAt)}.`}
                </p>
              </button>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function EvidenceFeedCard({
  title,
  subtitle,
  items,
  onOpen,
}: {
  title: string
  subtitle: string
  items: Array<{ title: string; kind: string; summary: string; supportingPath: string; updatedAt: string }>
  onOpen: (path: string) => void
}) {
  return (
    <Card className="border-border/50">
      <CardContent className="p-5">
        <div>
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="mt-4 space-y-2">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No evidence events have changed the world model yet.</p>
          ) : (
            items.map((item) => (
              <button
                key={`${item.supportingPath}-${item.updatedAt}`}
                onClick={() => onOpen(item.supportingPath)}
                className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-3 text-left hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <Badge variant="secondary" className="text-[10px]">{item.kind}</Badge>
                </div>
                <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">{item.summary}</p>
                <p className="mt-2 text-[11px] text-muted-foreground">{timeAgo(item.updatedAt)}</p>
              </button>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function ModeStatusStrip({
  nowSummary,
}: {
  nowSummary: ReturnType<typeof buildIntelligenceNowSummary>
}) {
  const cards = [
    {
      label: 'Needs you',
      value: nowSummary.needsAttention.length,
      detail: nowSummary.needsAttention[0]?.title ?? 'Nothing urgent for you',
    },
    {
      label: 'Blocked',
      value: nowSummary.blocked.length,
      detail: nowSummary.blocked[0]?.title ?? 'No blocked initiatives',
    },
    {
      label: 'Waiting',
      value: nowSummary.waiting.length,
      detail: nowSummary.waiting[0]?.title ?? 'No waiting items',
    },
  ]

  return (
    <div className="mt-6 grid gap-3 md:grid-cols-3">
      {cards.map((card) => (
        <Card key={card.label} className="border-border/50">
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold">{card.value}</p>
            <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{card.detail}</p>
          </CardContent>
        </Card>
      ))}
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
            .select('id, title, status, phase, next_milestone, next_review_at, last_signal_at, last_reconciled_at, latest_summary, current_hypothesis, open_questions, known_risks')
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
              lastReconciledAt: typeof row.last_reconciled_at === 'string' ? row.last_reconciled_at : null,
              latestSummary: typeof row.latest_summary === 'string' ? row.latest_summary : null,
              currentHypothesis: typeof row.current_hypothesis === 'string' ? row.current_hypothesis : null,
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

  const accountWorkspace = useMemo(
    () => buildAccountWorkspaceSummary({
      accounts: entryPoints?.accounts ?? [],
      relationships: entryPoints?.relationships ?? [],
      recentlyChanged: entryPoints?.recentlyChanged ?? [],
    }),
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

  const changedDocsForInitiative = useMemo(
    () => selectedInitiative ? findChangedDocsForInitiative(selectedInitiative, initiativeRelatedDocs) : [],
    [initiativeRelatedDocs, selectedInitiative]
  )

  const initiativeManualContext = useMemo(
    () => summarizeInitiativeManualContext(initiativeRelatedDocs),
    [initiativeRelatedDocs]
  )

  const nowSummary = useMemo(
    () => buildIntelligenceNowSummary({
      initiatives,
      recentlyChanged: entryPoints?.recentlyChanged ?? [],
      jumpBackIn: entryPoints?.jumpBackIn ?? [],
      work: entryPoints?.work ?? [],
      meetings: entryPoints?.meetings ?? [],
      operationalMemory: chiefWorldModel?.operationalMemory ?? null,
    }),
    [chiefWorldModel, entryPoints, initiatives]
  )

  const evidenceFeed = useMemo(
    () => buildEvidenceFeed({
      meetings: entryPoints?.meetings ?? [],
      recentlyChanged: entryPoints?.recentlyChanged ?? [],
      work: entryPoints?.work ?? [],
      initiatives,
    }),
    [entryPoints, initiatives]
  )

  const documentLeadSummary = useMemo(() => {
    const leadSection = document?.document.sections.find((section) =>
      section.kind === 'summary' || section.kind === 'narrative' || section.kind === 'changes'
    )
    return typeof leadSection?.content === 'string' ? leadSection.content : null
  }, [document])

  const documentInitiatives = useMemo(() => {
    if (!document) return []

    const persistedImpacts = (document.impactedInitiatives ?? []).map((impacted) => {
      const fromWorkspace = initiatives.find((initiative) => initiative.id === impacted.id)
      return fromWorkspace ?? {
        id: impacted.id,
        title: impacted.title,
        status: impacted.status,
        phase: impacted.phase,
        nextMilestone: impacted.nextMilestone,
        nextReviewAt: null,
        lastSignalAt: null,
        latestSummary: impacted.latestSummary,
        currentHypothesis: null,
        openQuestionCount: 0,
        riskCount: 0,
      }
    })

    if (persistedImpacts.length > 0) {
      return persistedImpacts
    }

    return findInitiativesForDocument(
      {
        title: document.document.title,
        summary: documentLeadSummary,
        path: document.document.path,
      },
      initiatives
    )
  }, [document, documentLeadSummary, initiatives])

  const isAccountDocument = selectedPanel === 'accounts'
    && !!document
    && ['narrative', 'entity'].includes(document.document.document_type)

  const isEvidenceDocument = selectedPanel === 'evidence'
    && !!document
    && document.document.document_type === 'source_artifact'

  const documentPriorityReason = useMemo(
    () => isAccountDocument && document
      ? explainAccountPriority({
        title: document.document.title,
        changedSummary: document.compare.previousSummary ?? documentLeadSummary,
        initiatives: documentInitiatives,
      })
      : null,
    [document, documentInitiatives, documentLeadSummary, isAccountDocument]
  )

  const selectedEvidenceEntry = useMemo(
    () => selectedPanel === 'evidence' && document
      ? evidenceFeed.find((entry) => entry.supportingPath === document.document.path) ?? null
      : null,
    [document, evidenceFeed, selectedPanel]
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
      case 'evidence':
        return (
          <>
            <SidebarEntryList
              title="Recent source records"
              entries={entryPoints?.meetings ?? []}
              selectedPath={selectedPath}
              onSelect={openDocument}
            />
            <SidebarEntryList
              title="Changed from evidence"
              entries={(entryPoints?.recentlyChanged ?? []).filter((entry) => entry.documentType === 'source_artifact' || entry.path.startsWith('Sources/'))}
              selectedPath={selectedPath}
              onSelect={openDocument}
            />
          </>
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

  const showPanelLanding = !selectedPath && !selectedInitiative

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
              Start with today, then drill into initiatives, accounts, evidence, and work. The graph stays underneath, but this page should feel like your operating workspace instead of a debug console.
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

      <ModeStatusStrip nowSummary={nowSummary} />

      <div className="mt-6 grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)_320px]">
        <Card className="border-border/50">
          <CardContent className="p-4">
            <div className="flex flex-wrap gap-2">
              {[
                ['today', 'Today'],
                ['initiatives', 'Initiatives'],
                ['accounts', 'Accounts'],
                ['evidence', 'Evidence'],
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
              ) : showPanelLanding && selectedPanel === 'today' ? (
                <IntelligenceHome
                  jumpBackIn={entryPoints?.jumpBackIn ?? []}
                  initiatives={initiatives}
                  nowSummary={nowSummary}
                  onOpenDocument={openDocument}
                  onOpenInitiative={(initiativeId) => {
                    setSelectedPanel('initiatives')
                    setSelectedPath(null)
                    setSelectedInitiativeId(initiativeId)
                  }}
                />
              ) : showPanelLanding && selectedPanel === 'accounts' ? (
                <div className="space-y-6 p-6">
                  <Card className="border-primary/15 bg-primary/[0.03] shadow-none">
                    <CardContent className="p-6">
                      <h2 className="text-2xl font-semibold tracking-tight">Accounts and relationships</h2>
                      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                        Use this view to understand account state, relationship movement, and where current work is attached.
                      </p>
                    </CardContent>
                  </Card>

                  <div className="grid gap-6 xl:grid-cols-2">
                    <AccountSpotlight
                      title="Active account dossiers"
                      subtitle="The accounts with the freshest narratives and org docs."
                      entries={accountWorkspace.featuredAccounts}
                      onOpen={openDocument}
                    />
                    <AccountSpotlight
                      title="Relationship stories"
                      subtitle="Cross-company docs that explain how relationships are evolving."
                      entries={accountWorkspace.relationshipDocs}
                      onOpen={openDocument}
                    />
                    <AccountSpotlight
                      title="Recently changed account context"
                      subtitle="The account docs that changed most recently."
                      entries={accountWorkspace.recentAccountChanges}
                      onOpen={openDocument}
                    />
                    <HomeSection
                      title="Jump back in"
                      subtitle="The fastest narratives and briefs to reopen before working an account."
                      entries={entryPoints?.jumpBackIn ?? []}
                      onOpen={openDocument}
                    />
                  </div>
                </div>
              ) : showPanelLanding && selectedPanel === 'evidence' ? (
                <div className="space-y-6 p-6">
                  <Card className="border-primary/15 bg-primary/[0.03] shadow-none">
                    <CardContent className="p-6">
                      <h2 className="text-2xl font-semibold tracking-tight">Evidence and explainability</h2>
                      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                        This is the “why” layer. Open it to see which meetings, threads, and source records actually changed the chief’s view.
                      </p>
                    </CardContent>
                  </Card>

                  <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.85fr)]">
                    <EvidenceFeedCard
                      title="What changed the world model"
                      subtitle="Recent source records and the impact they had on work or narratives."
                      items={evidenceFeed}
                      onOpen={openDocument}
                    />
                    <div className="space-y-6">
                      <HomeSection
                        title="Recent source records"
                        subtitle="Meetings and source docs worth opening directly."
                        entries={entryPoints?.meetings ?? []}
                        onOpen={openDocument}
                      />
                      <HomeSection
                        title="Docs regenerated from evidence"
                        subtitle="The narratives, briefs, and work docs that moved because of recent source changes."
                        entries={entryPoints?.recentlyChanged ?? []}
                        onOpen={openDocument}
                      />
                    </div>
                  </div>
                </div>
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
                      {selectedInitiative.currentHypothesis && (
                        <div className="mt-4 rounded-xl border border-border/50 bg-muted/20 p-3">
                          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Current hypothesis</p>
                          <p className="mt-2 text-sm text-muted-foreground">{selectedInitiative.currentHypothesis}</p>
                        </div>
                      )}
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
                    <section className="rounded-2xl border border-border/50 p-4 md:col-span-2">
                      <h3 className="text-base font-medium">Changed since last review</h3>
                      <div className="mt-3 space-y-2">
                        {changedDocsForInitiative.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No linked vault docs changed after the last initiative checkpoint yet.</p>
                        ) : (
                          changedDocsForInitiative.map((doc) => (
                            <button
                              key={doc.path}
                              onClick={() => openDocument(doc.path)}
                              className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <p className="truncate text-sm font-medium">{doc.title}</p>
                                <span className="text-xs text-muted-foreground">{timeAgo(doc.updatedAt)}</span>
                              </div>
                              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                {doc.summary ?? `${labelDocumentType(doc.documentType)} updated.`}
                              </p>
                            </button>
                          ))
                        )}
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
                    <section className="rounded-2xl border border-border/50 p-4">
                      <h3 className="text-base font-medium">Manual context from vault</h3>
                      <div className="mt-3 space-y-2">
                        {initiativeManualContext.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No manual notes or hypotheses have been linked into this initiative yet.</p>
                        ) : (
                          initiativeManualContext.map((snippet, index) => (
                            <div key={`${index}-${snippet.slice(0, 24)}`} className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                              {snippet}
                            </div>
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
              ) : isAccountDocument ? (
                <div className="p-6">
                  <div className="flex flex-col gap-3 border-b border-border/50 pb-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{labelDocumentType(document.document.document_type)}</Badge>
                      <Badge variant="outline">Account dossier</Badge>
                      <Badge variant="outline">{document.document.render_strategy.replace(/_/g, ' ')}</Badge>
                    </div>
                    <h2 className="text-2xl font-semibold tracking-tight">{document.document.title}</h2>
                    <p className="text-sm text-muted-foreground">
                      {documentLeadSummary ?? 'This account doc is now part of the chief-facing dossier layer.'}
                    </p>
                  </div>

                  <div className="mt-6 grid gap-4 md:grid-cols-2">
                    <section className="rounded-2xl border border-border/50 p-4">
                      <h3 className="text-base font-medium">Relationship status</h3>
                      <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
                        {documentLeadSummary ?? 'No relationship summary has been written yet.'}
                      </p>
                    </section>
                    <section className="rounded-2xl border border-border/50 p-4">
                      <h3 className="text-base font-medium">Why this account is prioritized</h3>
                      <p className="mt-3 text-sm text-muted-foreground">
                        {documentPriorityReason}
                      </p>
                    </section>
                    <section className="rounded-2xl border border-border/50 p-4">
                      <h3 className="text-base font-medium">What changed recently</h3>
                      <p className="mt-3 text-sm text-muted-foreground">
                        {document.compare.previousSummary ?? 'No explicit change summary yet. Open the linked context to see the latest supporting docs.'}
                      </p>
                    </section>
                    <section className="rounded-2xl border border-border/50 p-4">
                      <h3 className="text-base font-medium">Linked initiatives</h3>
                      <div className="mt-3 space-y-2">
                        {documentInitiatives.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No initiative is linked yet.</p>
                        ) : (
                          documentInitiatives.map((initiative) => (
                            <button
                              key={initiative.id}
                              onClick={() => {
                                setSelectedPanel('initiatives')
                                setSelectedInitiativeId(initiative.id)
                                setSelectedPath(null)
                              }}
                              className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <p className="truncate text-sm font-medium">{initiative.title}</p>
                                <Badge variant="secondary" className="text-[10px]">{initiative.phase}</Badge>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">{describeLikelyNextAction(initiative)}</p>
                            </button>
                          ))
                        )}
                      </div>
                    </section>
                    <section className="rounded-2xl border border-border/50 p-4">
                      <h3 className="text-base font-medium">What the chief will likely do next</h3>
                      <div className="mt-3 space-y-2">
                        {documentInitiatives.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No linked initiative means the chief does not yet have a concrete next move scoped here.</p>
                        ) : (
                          documentInitiatives.map((initiative) => (
                            <div key={`${initiative.id}-next`} className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2">
                              <p className="text-sm font-medium">{initiative.title}</p>
                              <p className="mt-1 text-xs text-muted-foreground">{describeLikelyNextAction(initiative)}</p>
                            </div>
                          ))
                        )}
                      </div>
                    </section>
                  </div>

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
                      </section>
                    ))}
                  </div>
                </div>
              ) : isEvidenceDocument ? (
                <div className="p-6">
                  <div className="flex flex-col gap-3 border-b border-border/50 pb-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">Source</Badge>
                      <Badge variant="outline">Explainability view</Badge>
                    </div>
                    <h2 className="text-2xl font-semibold tracking-tight">{document.document.title}</h2>
                    <p className="text-sm text-muted-foreground">
                      {selectedEvidenceEntry?.summary ?? documentLeadSummary ?? 'This source changed the chief view.'}
                    </p>
                  </div>

                  <div className="mt-6 grid gap-4 md:grid-cols-2">
                    <section className="rounded-2xl border border-border/50 p-4">
                      <h3 className="text-base font-medium">Why this mattered</h3>
                      <p className="mt-3 text-sm text-muted-foreground">
                        {selectedEvidenceEntry?.summary ?? 'This source was recorded because it materially changed the evidence-backed state.'}
                      </p>
                    </section>
                    <section className="rounded-2xl border border-border/50 p-4">
                      <h3 className="text-base font-medium">Affected initiatives</h3>
                      <div className="mt-3 space-y-2">
                        {documentInitiatives.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No initiative was confidently linked to this source yet.</p>
                        ) : (
                          documentInitiatives.map((initiative) => (
                            <button
                              key={initiative.id}
                              onClick={() => {
                                setSelectedPanel('initiatives')
                                setSelectedInitiativeId(initiative.id)
                                setSelectedPath(null)
                              }}
                              className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <p className="truncate text-sm font-medium">{initiative.title}</p>
                                <Badge variant="secondary" className="text-[10px]">{initiative.status}</Badge>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {describeLikelyNextAction(initiative)}
                                {selectedEvidenceEntry?.relatedInitiatives.includes(initiative.title)
                                  ? ' This source directly reinforced that initiative.'
                                  : ''}
                              </p>
                            </button>
                          ))
                        )}
                      </div>
                    </section>
                  </div>

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
                      </section>
                    ))}
                  </div>
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
          {showPanelLanding && selectedPanel === 'today' ? (
            <>
              <Card className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <BrainCircuit className="h-4 w-4 text-primary" />
                    What the chief believes
                  </div>
                  <div className="mt-4 space-y-3 text-sm text-muted-foreground">
                    <p>The chief is currently tracking <span className="font-medium text-foreground">{nowSummary.topPriorities.length}</span> active priorities.</p>
                    <p><span className="font-medium text-foreground">{nowSummary.needsAttention.length}</span> items need your attention, and <span className="font-medium text-foreground">{nowSummary.blocked.length}</span> are blocked.</p>
                    <p><span className="font-medium text-foreground">{nowSummary.waiting.length}</span> items are in a waiting state while the chief watches for new signals.</p>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <FileClock className="h-4 w-4 text-primary" />
                    Evidence used
                  </div>
                  <div className="mt-4 space-y-2">
                    {nowSummary.evidenceUsed.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No evidence-backed docs have been pulled into the current view yet.</p>
                    ) : (
                      nowSummary.evidenceUsed.map((entry) => (
                        <button
                          key={entry.path}
                          onClick={() => openDocument(entry.path)}
                          className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                        >
                          <p className="truncate text-sm font-medium">{entry.title}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {labelDocumentType(entry.documentType)} · {timeAgo(entry.updatedAt)}
                          </p>
                        </button>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Workflow className="h-4 w-4 text-primary" />
                    What changed the world model
                  </div>
                  <div className="mt-4 space-y-2">
                    {nowSummary.recentSources.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No recent source events have changed the world model yet.</p>
                    ) : (
                      nowSummary.recentSources.map((entry) => (
                        <button
                          key={entry.path}
                          onClick={() => openDocument(entry.path)}
                          className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                        >
                          <p className="truncate text-sm font-medium">{entry.title}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {entry.summary ?? `${labelDocumentType(entry.documentType)} updated.`}
                          </p>
                        </button>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </>
          ) : showPanelLanding && selectedPanel === 'accounts' ? (
            <>
              <Card className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Link2 className="h-4 w-4 text-primary" />
                    How to read accounts
                  </div>
                  <div className="mt-4 space-y-3 text-sm text-muted-foreground">
                    <p>Use account narratives to understand relationship status and what changed recently.</p>
                    <p>Open relationship docs when work spans multiple companies or stakeholders.</p>
                    <p>Use the connected docs in the center pane to jump into the actual evidence and work behind the story.</p>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <History className="h-4 w-4 text-primary" />
                    Recent account movement
                  </div>
                  <div className="mt-4 space-y-2">
                    {accountWorkspace.recentAccountChanges.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No account docs changed recently.</p>
                    ) : (
                      accountWorkspace.recentAccountChanges.map((entry) => (
                        <button
                          key={entry.path}
                          onClick={() => openDocument(entry.path)}
                          className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                        >
                          <p className="truncate text-sm font-medium">{entry.title}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{timeAgo(entry.updatedAt)}</p>
                        </button>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </>
          ) : showPanelLanding && selectedPanel === 'evidence' ? (
            <>
              <Card className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <FileClock className="h-4 w-4 text-primary" />
                    How to read evidence
                  </div>
                  <div className="mt-4 space-y-3 text-sm text-muted-foreground">
                    <p>Each evidence item is a source record that changed the chief’s state.</p>
                    <p>Open a source to inspect the meeting, thread, or message that triggered an update.</p>
                    <p>Then compare it with the regenerated docs to see how the chief translated that signal into action.</p>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Workflow className="h-4 w-4 text-primary" />
                    Recent evidence impact
                  </div>
                  <div className="mt-4 space-y-2">
                    {evidenceFeed.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No evidence impact captured yet.</p>
                    ) : (
                      evidenceFeed.slice(0, 6).map((item) => (
                        <button
                          key={`${item.supportingPath}-${item.updatedAt}-rail`}
                          onClick={() => openDocument(item.supportingPath)}
                          className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                        >
                          <p className="truncate text-sm font-medium">{item.title}</p>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.summary}</p>
                        </button>
                      ))
                    )}
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
