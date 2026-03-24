'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Wrench,
  Check,
  X,
  ChevronDown,
  Loader2,
  Mail,
  MessageSquare,
  Calendar,
  ShieldCheck,
  Brain,
  Database,
  Plug,
  Terminal,
} from 'lucide-react'
import type { ToolCallPart as ToolCallPartType, ToolResultPart as ToolResultPartType } from '@/types/chat'
import type { ToolIconCategory } from '@/lib/agent/tool-metadata'

interface ToolCallBlockProps {
  part: ToolCallPartType
  resultPart?: ToolResultPartType
}

// ─── Tool Category Icons ─────────────────────────────────────────────────

function ToolIcon({ category, className }: { category: ToolIconCategory; className?: string }) {
  const cls = cn('shrink-0', className)

  switch (category) {
    case 'email':
      return <Mail className={cn(cls, 'h-3.5 w-3.5')} />
    case 'slack':
      return <MessageSquare className={cn(cls, 'h-3.5 w-3.5')} />
    case 'calendar':
      return <Calendar className={cn(cls, 'h-3.5 w-3.5')} />
    case 'compliance':
      return <ShieldCheck className={cn(cls, 'h-3.5 w-3.5')} />
    case 'memory':
      return <Brain className={cn(cls, 'h-3.5 w-3.5')} />
    case 'database':
      return <Database className={cn(cls, 'h-3.5 w-3.5')} />
    case 'integration':
      return <Plug className={cn(cls, 'h-3.5 w-3.5')} />
    case 'builtin':
      return <Terminal className={cn(cls, 'h-3.5 w-3.5')} />
    default:
      return <Wrench className={cn(cls, 'h-3.5 w-3.5')} />
  }
}

// ─── Status Indicator ────────────────────────────────────────────────────

function StatusIndicator({ status }: { status: ToolCallPartType['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
    case 'completed':
      return <Check className="h-3.5 w-3.5 text-emerald-500" />
    case 'failed':
      return <X className="h-3.5 w-3.5 text-destructive" />
  }
}

// ─── Tool Call Block ─────────────────────────────────────────────────────

const TOOL_ICON_CATEGORIES: Record<string, ToolIconCategory> = {
  read_recent_emails: 'email',
  search_emails: 'email',
  draft_email: 'email',
  send_slack_dm: 'slack',
  send_approval_message: 'slack',
  update_slack_message: 'slack',
  get_today_events: 'calendar',
  get_week_events: 'calendar',
  find_free_slots: 'calendar',
  create_calendar_event: 'calendar',
  get_compliance_overview: 'compliance',
  list_failing_controls: 'compliance',
  get_audit_status: 'compliance',
  recall_memory: 'memory',
  store_memory: 'memory',
  update_memory: 'memory',
  query_commitments: 'database',
  create_commitment: 'database',
  update_commitment: 'database',
  query_actions: 'database',
  create_action: 'database',
  resolve_action: 'database',
  list_connected_integrations: 'integration',
  get_integration_health: 'integration',

  // Built-in SDK tools
  Bash: 'builtin',
  Read: 'builtin',
  Write: 'builtin',
  Edit: 'builtin',
  Glob: 'builtin',
  Grep: 'builtin',
}

export function ToolCallBlock({ part, resultPart }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const category = TOOL_ICON_CATEGORIES[part.toolName] || 'default'

  return (
    <div className="my-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors cursor-pointer',
          'text-muted-foreground hover:bg-accent hover:text-foreground',
          part.status === 'failed' && 'text-destructive/80'
        )}
      >
        <ToolIcon category={category} />
        <span className="font-medium">{part.displayName}</span>
        <StatusIndicator status={part.status} />
        {typeof part.durationMs === 'number' && part.durationMs > 0 && (
          <span className="text-[10px] text-muted-foreground/40">
            {part.durationMs < 1000
              ? `${part.durationMs}ms`
              : `${(part.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
        <ChevronDown
          className={cn(
            'h-2.5 w-2.5 transition-transform shrink-0 ml-0.5',
            expanded ? 'rotate-180' : ''
          )}
        />
      </button>

      {expanded && (
        <div className="mt-1 ml-1 space-y-1.5">
          {/* Tool Input */}
          {Object.keys(part.toolInput).length > 0 && (
            <div className="rounded-md border border-border bg-accent/30 p-3">
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
                Input
              </p>
              <pre className="whitespace-pre-wrap text-xs text-muted-foreground font-mono leading-relaxed overflow-x-auto">
                {JSON.stringify(part.toolInput, null, 2)}
              </pre>
            </div>
          )}

          {/* Tool Result */}
          {resultPart && (
            <div
              className={cn(
                'rounded-md border p-3',
                resultPart.success
                  ? 'bg-accent/30 border-border'
                  : 'bg-destructive/5 border-destructive/20'
              )}
            >
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
                {resultPart.success ? 'Result' : 'Error'}
              </p>
              <pre className="whitespace-pre-wrap text-xs text-muted-foreground font-mono leading-relaxed overflow-x-auto max-h-[300px] overflow-y-auto">
                {resultPart.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
