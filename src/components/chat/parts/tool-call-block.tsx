'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
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
      return (
        <svg className={cls} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="20" height="16" x="2" y="4" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      )
    case 'slack':
      return (
        <svg className={cls} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="3" height="8" x="13" y="2" rx="1.5" />
          <path d="M19 8.5V10h1.5A1.5 1.5 0 1 0 19 8.5" />
          <rect width="3" height="8" x="8" y="14" rx="1.5" />
          <path d="M5 15.5V14H3.5A1.5 1.5 0 1 0 5 15.5" />
          <rect width="8" height="3" x="14" y="13" rx="1.5" />
          <path d="M15.5 19H14v1.5a1.5 1.5 0 1 0 1.5-1.5" />
          <rect width="8" height="3" x="2" y="8" rx="1.5" />
          <path d="M8.5 5H10V3.5A1.5 1.5 0 1 0 8.5 5" />
        </svg>
      )
    case 'calendar':
      return (
        <svg className={cls} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
          <line x1="16" x2="16" y1="2" y2="6" />
          <line x1="8" x2="8" y1="2" y2="6" />
          <line x1="3" x2="21" y1="10" y2="10" />
        </svg>
      )
    case 'compliance':
      return (
        <svg className={cls} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      )
    case 'memory':
      return (
        <svg className={cls} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a8 8 0 0 0-8 8c0 3.4 2.1 6.3 5 7.5V20h6v-2.5c2.9-1.2 5-4.1 5-7.5a8 8 0 0 0-8-8z" />
          <path d="M12 2v4" />
          <path d="M8 6l2 2" />
          <path d="M16 6l-2 2" />
        </svg>
      )
    case 'database':
      return (
        <svg className={cls} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5V19a9 3 0 0 0 18 0V5" />
          <path d="M3 12a9 3 0 0 0 18 0" />
        </svg>
      )
    case 'integration':
      return (
        <svg className={cls} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v6" />
          <path d="M12 18v4" />
          <circle cx="12" cy="12" r="4" />
          <path d="M4.93 4.93l4.24 4.24" />
          <path d="M14.83 14.83l4.24 4.24" />
          <path d="M2 12h6" />
          <path d="M18 12h4" />
          <path d="M4.93 19.07l4.24-4.24" />
          <path d="M14.83 9.17l4.24-4.24" />
        </svg>
      )
    case 'builtin':
      return (
        <svg className={cls} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" x2="20" y1="19" y2="19" />
        </svg>
      )
    default:
      return (
        <svg className={cls} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      )
  }
}

// ─── Status Indicator ────────────────────────────────────────────────────

function StatusIndicator({ status }: { status: ToolCallPartType['status'] }) {
  switch (status) {
    case 'running':
      return (
        <svg className="h-3.5 w-3.5 animate-spin text-muted-foreground" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )
    case 'completed':
      return (
        <svg className="h-3.5 w-3.5 text-emerald-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )
    case 'failed':
      return (
        <svg className="h-3.5 w-3.5 text-destructive" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" x2="6" y1="6" y2="18" />
          <line x1="6" x2="18" y1="6" y2="18" />
        </svg>
      )
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
          'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors',
          'border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
          part.status === 'failed' && 'border-destructive/30 bg-destructive/5'
        )}
      >
        <ToolIcon category={category} />
        <span className="font-medium">{part.displayName}</span>
        <StatusIndicator status={part.status} />
        {typeof part.durationMs === 'number' && part.durationMs > 0 && (
          <span className="text-[10px] text-muted-foreground/60">
            {part.durationMs < 1000
              ? `${part.durationMs}ms`
              : `${(part.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
        {/* Chevron */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={cn(
            'transition-transform shrink-0 ml-0.5',
            expanded ? 'rotate-180' : ''
          )}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-1.5 ml-1 space-y-1.5">
          {/* Tool Input */}
          {Object.keys(part.toolInput).length > 0 && (
            <div className="rounded-lg border bg-muted/20 p-3">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
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
                'rounded-lg border p-3',
                resultPart.success
                  ? 'bg-emerald-500/5 border-emerald-500/20'
                  : 'bg-destructive/5 border-destructive/20'
              )}
            >
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
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
