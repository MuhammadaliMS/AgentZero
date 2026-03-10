'use client'

import { useState } from 'react'
import {
  MessageSquare, MessageCircle, Hash, Mail, Layers,
  ChevronDown, ChevronRight, FileText, Users, Scale,
  ListChecks, Brain, BookOpen, GitBranch,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'

/* ─────────────────────── Types ─────────────────────── */

export interface EvidencePipelineRun {
  id: string
  channel: string
  title: string
  created_at: string
  evidence_count: number
  claim_count: number
  entity_count: number
  decision_thread_count: number
  commitment_count: number
  memory_count: number
  vault_doc_count: number
  claims_by_kind: Record<string, number>
  memories_by_category: Record<string, number>
  vault_paths: string[]
}

/* ─────────────────── Channel Config ────────────────── */

const CHANNEL_CONFIG: Record<string, {
  label: string
  icon: typeof MessageSquare
  accent: string
  bg: string
}> = {
  meeting: {
    label: 'Meeting',
    icon: MessageSquare,
    accent: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-50 dark:bg-blue-950/30',
  },
  chat: {
    label: 'Chat',
    icon: MessageCircle,
    accent: 'text-violet-600 dark:text-violet-400',
    bg: 'bg-violet-50 dark:bg-violet-950/30',
  },
  slack: {
    label: 'Slack',
    icon: Hash,
    accent: 'text-pink-600 dark:text-pink-400',
    bg: 'bg-pink-50 dark:bg-pink-950/30',
  },
  email: {
    label: 'Email',
    icon: Mail,
    accent: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
  },
}

/* ─────────────────── Helpers ───────────────────────── */

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatClaimKind(kind: string): string {
  return kind.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/* ─────────────── Detail Row Helper ─────────────────── */

function DetailRow({
  icon: Icon,
  iconClass,
  label,
  count,
  detail,
}: {
  icon: typeof FileText
  iconClass: string
  label: string
  count: number
  detail?: string
}) {
  if (count === 0) return null
  return (
    <div className="flex items-start gap-2 py-1">
      <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${iconClass}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium">{count}</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        {detail && (
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">{detail}</p>
        )}
      </div>
    </div>
  )
}

/* ─────────────── Pipeline Run Row ──────────────────── */

function PipelineRunRow({ run }: { run: EvidencePipelineRun }) {
  const [expanded, setExpanded] = useState(false)
  const config = CHANNEL_CONFIG[run.channel] || {
    label: run.channel,
    icon: FileText,
    accent: 'text-muted-foreground',
    bg: 'bg-muted/30',
  }
  const Icon = config.icon

  const totalItems = run.claim_count + run.commitment_count + run.decision_thread_count
  const claimBreakdown = Object.entries(run.claims_by_kind)
    .map(([kind, count]) => `${count} ${formatClaimKind(kind).toLowerCase()}`)
    .join(', ')
  const memoryBreakdown = Object.entries(run.memories_by_category)
    .map(([cat, count]) => `${count} ${cat.replace(/_/g, ' ')}`)
    .join(', ')

  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden transition-all duration-200 hover:border-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-3 text-left cursor-pointer hover:bg-muted/30 transition-colors"
      >
        {/* Channel icon */}
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${config.bg} shrink-0`}>
          <Icon className={`h-4 w-4 ${config.accent}`} />
        </div>

        {/* Title + time */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium truncate">{run.title}</h4>
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 shrink-0">
              {config.label}
            </Badge>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground">{timeAgo(run.created_at)}</span>
            <span className="text-[10px] text-muted-foreground/40">·</span>
            <span className="text-[10px] text-muted-foreground font-mono">{formatTime(run.created_at)}</span>
          </div>
        </div>

        {/* Stats summary */}
        <div className="flex items-center gap-2 shrink-0">
          {run.evidence_count > 0 && (
            <div className="text-right hidden sm:block">
              <p className="text-xs font-semibold">{run.evidence_count}</p>
              <p className="text-[9px] text-muted-foreground">evidence</p>
            </div>
          )}
          {totalItems > 0 && (
            <div className="text-right">
              <p className="text-xs font-semibold">{totalItems}</p>
              <p className="text-[9px] text-muted-foreground">items</p>
            </div>
          )}
          {run.vault_doc_count > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {run.vault_doc_count} docs
            </Badge>
          )}
        </div>

        {/* Chevron */}
        <div className="shrink-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border/40 px-4 py-3 space-y-0.5">
          <DetailRow
            icon={FileText}
            iconClass="text-blue-500"
            label="evidence items processed"
            count={run.evidence_count}
          />
          <DetailRow
            icon={Scale}
            iconClass="text-teal-500"
            label="claims created"
            count={run.claim_count}
            detail={claimBreakdown || undefined}
          />
          <DetailRow
            icon={Users}
            iconClass="text-indigo-500"
            label="entities created or updated"
            count={run.entity_count}
          />
          <DetailRow
            icon={ListChecks}
            iconClass="text-orange-500"
            label="commitments tracked"
            count={run.commitment_count}
          />
          <DetailRow
            icon={GitBranch}
            iconClass="text-cyan-500"
            label="decision threads"
            count={run.decision_thread_count}
          />
          <DetailRow
            icon={Brain}
            iconClass="text-violet-500"
            label="memories generated"
            count={run.memory_count}
            detail={memoryBreakdown || undefined}
          />
          <DetailRow
            icon={BookOpen}
            iconClass="text-sky-500"
            label="vault documents regenerated"
            count={run.vault_doc_count}
          />
          {run.vault_paths.length > 0 && (
            <div className="mt-2 ml-6 space-y-0.5">
              {run.vault_paths.slice(0, 8).map((path) => (
                <p key={path} className="text-[10px] text-muted-foreground/70 font-mono truncate">
                  {path}
                </p>
              ))}
              {run.vault_paths.length > 8 && (
                <p className="text-[10px] text-muted-foreground/50">
                  +{run.vault_paths.length - 8} more documents
                </p>
              )}
            </div>
          )}

          {run.claim_count === 0 && run.entity_count === 0 && run.commitment_count === 0 && (
            <p className="text-[10px] text-muted-foreground/60 italic py-2">
              No structured output from this run
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/* ─────────────── Main Component ────────────────────── */

export function EvidencePipelineMonitor({ runs }: { runs: EvidencePipelineRun[] }) {
  const totalRuns = runs.length
  const totalClaims = runs.reduce((sum, r) => sum + r.claim_count, 0)
  const totalVaultDocs = runs.reduce((sum, r) => sum + r.vault_doc_count, 0)

  const channelCounts = runs.reduce((acc, r) => {
    acc[r.channel] = (acc[r.channel] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  const channelSummary = Object.entries(channelCounts)
    .map(([ch, count]) => `${count} ${ch}`)
    .join(', ')

  if (totalRuns === 0) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Layers className="h-4 w-4 text-teal-500" />
          Evidence Pipeline
        </h3>
        <div className="rounded-xl border border-border/50 bg-card p-6 text-center">
          <p className="text-xs text-muted-foreground">No pipeline runs yet</p>
          <p className="text-[10px] text-muted-foreground/60 mt-1">
            Pipeline runs will appear here when meetings or conversations are processed
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Layers className="h-4 w-4 text-teal-500" />
          Evidence Pipeline
          <span className="text-xs font-normal text-muted-foreground">
            ({totalRuns} runs · {channelSummary})
          </span>
        </h3>
        <div className="flex items-center gap-2">
          {totalClaims > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {totalClaims} claims
            </Badge>
          )}
          {totalVaultDocs > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {totalVaultDocs} vault docs
            </Badge>
          )}
        </div>
      </div>
      <div className="space-y-2">
        {runs.map((run) => (
          <PipelineRunRow key={run.id} run={run} />
        ))}
      </div>
    </div>
  )
}
