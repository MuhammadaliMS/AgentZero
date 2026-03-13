'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  Clock3,
  FileClock,
  FolderTree,
  GitBranch,
  History,
  NotebookPen,
  RefreshCw,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { createClient } from '@/lib/supabase/client'
import {
  buildVaultTree,
  type VaultTreeNode,
} from '@/lib/evidence/vault'
import {
  flattenVaultDocumentPaths,
  groupEntryPointsByFreshness,
  labelDocumentType,
  type IntelligenceVaultEntryPoint,
} from '@/lib/evidence/intelligence-ui'

interface WorkspaceStats {
  vaultDocs: number
  claims: number
  commitments: number
  narratives: number
}

interface VaultTreeResponse {
  tree: VaultTreeNode[]
  total: number
  entryPoints: {
    accounts: IntelligenceVaultEntryPoint[]
    relationships: IntelligenceVaultEntryPoint[]
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
    updated_at?: string | null
    metadata?: Record<string, unknown> | null
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

function EntryList({
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

export function IntelligenceWorkspace() {
  const supabase = useMemo(() => createClient() as any, [])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<WorkspaceStats | null>(null)
  const [tree, setTree] = useState<VaultTreeNode[]>([])
  const [entryPoints, setEntryPoints] = useState<VaultTreeResponse['entryPoints'] | null>(null)
  const [changes, setChanges] = useState<ChangesResponse['changes']>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [document, setDocument] = useState<VaultDocumentPayload | null>(null)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [selectedPanel, setSelectedPanel] = useState<'accounts' | 'relationships' | 'jump' | 'raw'>('accounts')
  const [manualDrafts, setManualDrafts] = useState<Record<string, string>>({})
  const [savingSectionKey, setSavingSectionKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadWorkspace() {
      setLoading(true)
      setError(null)

      try {
        const [
          treeRes,
          changesRes,
          vaultDocsCountRes,
          claimsCountRes,
          commitmentsCountRes,
          narrativesCountRes,
        ] = await Promise.all([
          fetch('/api/vault/tree').then(async (response) => {
            if (!response.ok) throw new Error('Failed to load vault tree')
            return response.json() as Promise<VaultTreeResponse>
          }),
          fetch('/api/vault/changes').then(async (response) => {
            if (!response.ok) throw new Error('Failed to load vault changes')
            return response.json() as Promise<ChangesResponse>
          }),
          supabase.from('vault_documents').select('id', { count: 'exact', head: true }),
          supabase.from('claims').select('id', { count: 'exact', head: true }).eq('status', 'active'),
          supabase.from('commitments').select('id', { count: 'exact', head: true }).in('status', ['active', 'at_risk', 'overdue']),
          supabase.from('strategic_narratives').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        ])

        const documentPaths = flattenVaultDocumentPaths(treeRes.tree)

        if (!cancelled) {
          setTree(treeRes.tree)
          setEntryPoints(treeRes.entryPoints)
          setChanges(changesRes.changes)
          setExpandedFolders(new Set(treeRes.tree.map((node) => node.path)))
          setSelectedPath((current) => current ?? treeRes.entryPoints.jumpBackIn[0]?.path ?? treeRes.entryPoints.accounts[0]?.path ?? documentPaths[0] ?? null)
          setStats({
            vaultDocs: vaultDocsCountRes.count ?? 0,
            claims: claimsCountRes.count ?? 0,
            commitments: commitmentsCountRes.count ?? 0,
            narratives: narrativesCountRes.count ?? 0,
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

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-8 sm:px-6 sm:py-10">
      <header className="rounded-[2rem] border border-border/50 bg-card/90 px-6 py-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/5 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
              <NotebookPen className="h-3.5 w-3.5" />
              Vault Workspace
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
              Obsidian-like navigation over the evidence graph.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-[15px]">
              Accounts and relationships come first, raw folders are still available, and each document blends generated facts with Kimi-written interpretation and manual notes.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Vault docs', value: stats?.vaultDocs ?? 0, icon: BookOpen },
              { label: 'Active claims', value: stats?.claims ?? 0, icon: GitBranch },
              { label: 'Open work', value: stats?.commitments ?? 0, icon: Clock3 },
              { label: 'Narratives', value: stats?.narratives ?? 0, icon: BrainCircuit },
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
                ['accounts', 'Accounts'],
                ['relationships', 'Relationships'],
                ['jump', 'Jump back in'],
                ['raw', 'Raw vault'],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  variant={selectedPanel === value ? 'default' : 'outline'}
                  size="sm"
                  className="rounded-full"
                  onClick={() => setSelectedPanel(value as typeof selectedPanel)}
                >
                  {label}
                </Button>
              ))}
            </div>

            <ScrollArea className="mt-4 h-[72vh] pr-3">
              <div className="space-y-6">
                {selectedPanel === 'accounts' && (
                  <>
                    <EntryList
                      title="Fresh account docs"
                      entries={groupedAccounts.fresh}
                      selectedPath={selectedPath}
                      onSelect={setSelectedPath}
                    />
                    <EntryList
                      title="Older account docs"
                      entries={groupedAccounts.older}
                      selectedPath={selectedPath}
                      onSelect={setSelectedPath}
                    />
                  </>
                )}

                {selectedPanel === 'relationships' && (
                  <EntryList
                    title="Relationship docs"
                    entries={entryPoints?.relationships ?? []}
                    selectedPath={selectedPath}
                    onSelect={setSelectedPath}
                  />
                )}

                {selectedPanel === 'jump' && (
                  <>
                    <EntryList
                      title="Jump back in"
                      entries={entryPoints?.jumpBackIn ?? []}
                      selectedPath={selectedPath}
                      onSelect={setSelectedPath}
                    />
                    <EntryList
                      title="Recently changed"
                      entries={entryPoints?.recentlyChanged ?? []}
                      selectedPath={selectedPath}
                      onSelect={setSelectedPath}
                    />
                  </>
                )}

                {selectedPanel === 'raw' && (
                  tree.length === 0 ? (
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
                      onSelectDocument={setSelectedPath}
                    />
                  )
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="border-border/50">
          <CardContent className="p-0">
            <ScrollArea className="h-[78vh]">
              {!document ? (
                <div className="flex h-[78vh] items-center justify-center text-sm text-muted-foreground">
                  {loading ? 'Loading vault workspace…' : 'Select a document from the left'}
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
          <Card className="border-border/50">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <GitBranch className="h-4 w-4 text-primary" />
                Related objects
              </div>
              <div className="mt-4 space-y-2">
                {(document?.links ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No related links yet.</p>
                ) : (
                  document?.links.map((link) => (
                    <button
                      key={`${link.linkKind}-${link.targetId}`}
                      onClick={() => link.targetPath && setSelectedPath(link.targetPath)}
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
                <ArrowRight className="h-4 w-4 text-primary" />
                Backlinks
              </div>
              <div className="mt-4 space-y-2">
                {(document?.backlinks ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No backlinks yet.</p>
                ) : (
                  document?.backlinks.map((backlink) => (
                    <button
                      key={`${backlink.documentId}-${backlink.path}`}
                      onClick={() => setSelectedPath(backlink.path)}
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

          <Card className="border-border/50">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <RefreshCw className="h-4 w-4 text-primary" />
                Recently changed
              </div>
              <div className="mt-4 space-y-2">
                {changes.slice(0, 8).map((change) => (
                  <button
                    key={change.id}
                    onClick={() => setSelectedPath(change.path)}
                    className="w-full rounded-xl border border-border/50 bg-card/80 px-3 py-2 text-left hover:bg-muted/40"
                  >
                    <p className="truncate text-sm font-medium">{change.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {labelDocumentType(change.document_type)} · {timeAgo(change.updated_at)}
                    </p>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <BrainCircuit className="h-4 w-4 text-primary" />
                Product surfaces
              </div>
              <div className="mt-4 grid gap-2">
                {[
                  { href: '/knowledge-graph', label: 'Knowledge Graph' },
                  { href: '/meetings', label: 'Meetings' },
                  { href: '/command-center', label: 'Command Center' },
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
        </div>
      </div>
    </div>
  )
}
