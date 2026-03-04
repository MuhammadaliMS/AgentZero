'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ApprovalRequestPart as ApprovalRequestPartType } from '@/types/chat'

interface ApprovalCardProps {
  part: ApprovalRequestPartType
  onApproval: (approvalId: string, decision: 'approve' | 'reject') => void
}

// ─── Card Configuration ──────────────────────────────────────────────────

type AccentColor = 'purple' | 'blue' | 'green' | 'amber'
type CardIcon = 'slack' | 'email' | 'calendar' | 'default'

interface CardConfig {
  accent: AccentColor
  approveLabel: string
  icon: CardIcon
}

const TOOL_CARD_CONFIG: Record<string, CardConfig> = {
  send_slack_dm:        { accent: 'purple', approveLabel: 'Send DM',        icon: 'slack' },
  post_to_channel:      { accent: 'purple', approveLabel: 'Post Message',   icon: 'slack' },
  send_approval_message:{ accent: 'purple', approveLabel: 'Post Request',   icon: 'slack' },
  update_slack_message: { accent: 'purple', approveLabel: 'Update Message', icon: 'slack' },
  draft_email:          { accent: 'blue',   approveLabel: 'Create Draft',   icon: 'email' },
  send_email:           { accent: 'blue',   approveLabel: 'Send Email',     icon: 'email' },
  create_calendar_event:{ accent: 'green',  approveLabel: 'Create Event',   icon: 'calendar' },
}

const DEFAULT_CONFIG: CardConfig = { accent: 'amber', approveLabel: 'Approve', icon: 'default' }

function getCardConfig(toolName: string): CardConfig {
  return TOOL_CARD_CONFIG[toolName] ?? DEFAULT_CONFIG
}

// Tailwind purges dynamic classes, so we use pre-written static class maps
const PENDING_ACCENT = {
  purple: { border: 'border-purple-500/40', bg: 'bg-purple-500/5', iconBg: 'bg-purple-500/10', iconText: 'text-purple-600 dark:text-purple-400', button: 'bg-purple-600 hover:bg-purple-700' },
  blue:   { border: 'border-blue-500/40',   bg: 'bg-blue-500/5',   iconBg: 'bg-blue-500/10',   iconText: 'text-blue-600 dark:text-blue-400',   button: 'bg-blue-600 hover:bg-blue-700' },
  green:  { border: 'border-green-500/40',  bg: 'bg-green-500/5',  iconBg: 'bg-green-500/10',  iconText: 'text-green-600 dark:text-green-400', button: 'bg-green-600 hover:bg-green-700' },
  amber:  { border: 'border-amber-500/40',  bg: 'bg-amber-500/5',  iconBg: 'bg-amber-500/10',  iconText: 'text-amber-600 dark:text-amber-400', button: 'bg-emerald-600 hover:bg-emerald-700' },
}

// ─── Tool-Specific Icons ─────────────────────────────────────────────────

function CardIcon({ icon, className }: { icon: CardIcon; className?: string }) {
  const cls = cn('shrink-0', className)
  switch (icon) {
    case 'slack':
      return (
        <svg className={cls} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    case 'email':
      return (
        <svg className={cls} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="20" height="16" x="2" y="4" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      )
    case 'calendar':
      return (
        <svg className={cls} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
          <line x1="16" x2="16" y1="2" y2="6" />
          <line x1="8" x2="8" y1="2" y2="6" />
          <line x1="3" x2="21" y1="10" y2="10" />
        </svg>
      )
    default:
      return (
        <svg className={cls} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
      )
  }
}

// ─── Status Icons (for resolved states) ──────────────────────────────────

function StatusIcon({ status }: { status: ApprovalRequestPartType['status'] }) {
  switch (status) {
    case 'approved':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      )
    case 'rejected':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
          <line x1="15" x2="9" y1="9" y2="15" />
          <line x1="9" x2="15" y1="9" y2="15" />
        </svg>
      )
    case 'expired':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      )
    default:
      return null
  }
}

// ─── Tool-Specific Content Previews ──────────────────────────────────────

function SlackPreview({ toolInput }: { toolInput: Record<string, unknown> }) {
  const recipient = (toolInput.recipient || toolInput.user_id || toolInput.user_email || toolInput.channel_id) as string | undefined
  const message = (toolInput.message || toolInput.text) as string | undefined
  const threadTs = toolInput.thread_ts as string | undefined

  return (
    <div className="mt-2.5 space-y-1.5">
      {recipient && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">To:</span>
          <span>{recipient}</span>
        </div>
      )}
      {threadTs && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">Thread:</span>
          <span className="font-mono text-[10px]">{threadTs}</span>
        </div>
      )}
      {message && (
        <div className="mt-1.5 rounded-lg border border-purple-500/15 bg-purple-500/[0.03] px-3 py-2">
          <p className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed">{truncateStr(message, 500)}</p>
        </div>
      )}
    </div>
  )
}

function EmailPreview({ toolInput }: { toolInput: Record<string, unknown> }) {
  const to = toolInput.to as string | undefined
  const cc = toolInput.cc as string | undefined
  const subject = toolInput.subject as string | undefined
  const body = (toolInput.body || toolInput.html_body) as string | undefined
  const replyTo = toolInput.in_reply_to as string | undefined

  return (
    <div className="mt-2.5 space-y-1.5">
      {to && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">To:</span>
          <span>{to}</span>
        </div>
      )}
      {cc && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">CC:</span>
          <span>{cc}</span>
        </div>
      )}
      {subject && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">Subject:</span>
          <span className="font-medium text-foreground/80">{subject}</span>
        </div>
      )}
      {replyTo && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">Reply to:</span>
          <span className="font-mono text-[10px]">{replyTo}</span>
        </div>
      )}
      {body && (
        <div className="mt-1.5 rounded-lg border border-blue-500/15 bg-blue-500/[0.03] px-3 py-2">
          <p className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed">{truncateStr(body, 500)}</p>
        </div>
      )}
    </div>
  )
}

function CalendarPreview({ toolInput }: { toolInput: Record<string, unknown> }) {
  const title = toolInput.title as string | undefined
  const startTime = toolInput.start_time as string | undefined
  const endTime = toolInput.end_time as string | undefined
  const timezone = toolInput.timezone as string | undefined
  const attendees = toolInput.attendees as string[] | null | undefined
  const location = toolInput.location as string | undefined
  const description = toolInput.description as string | undefined

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    } catch { return iso }
  }

  return (
    <div className="mt-2.5 space-y-1.5">
      {title && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">Event:</span>
          <span className="font-medium text-foreground/80">{title}</span>
        </div>
      )}
      {startTime && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">When:</span>
          <span>{formatTime(startTime)}{endTime ? ` — ${formatTime(endTime)}` : ''}</span>
        </div>
      )}
      {timezone && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">Timezone:</span>
          <span>{timezone}</span>
        </div>
      )}
      {attendees && attendees.length > 0 && (
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70 shrink-0">Attendees:</span>
          <span>{attendees.join(', ')}</span>
        </div>
      )}
      {location && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">Location:</span>
          <span>{location}</span>
        </div>
      )}
      {description && (
        <div className="mt-1.5 rounded-lg border border-green-500/15 bg-green-500/[0.03] px-3 py-2">
          <p className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed">{truncateStr(description, 300)}</p>
        </div>
      )}
    </div>
  )
}

function DefaultPreview({ description }: { description: string }) {
  return (
    <div className="mt-1.5 text-xs text-muted-foreground prose prose-xs dark:prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {description}
      </ReactMarkdown>
    </div>
  )
}

function ToolPreview({ toolName, toolInput, description }: {
  toolName: string
  toolInput: Record<string, unknown>
  description: string
}) {
  // Use tool-specific previews for known tools, else fallback to markdown description
  if (['send_slack_dm', 'post_to_channel', 'send_approval_message', 'update_slack_message'].includes(toolName)) {
    return <SlackPreview toolInput={toolInput} />
  }
  if (['draft_email', 'send_email'].includes(toolName)) {
    return <EmailPreview toolInput={toolInput} />
  }
  if (toolName === 'create_calendar_event') {
    return <CalendarPreview toolInput={toolInput} />
  }
  if (description) {
    return <DefaultPreview description={description} />
  }
  return null
}

// ─── Spinner ─────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function truncateStr(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str
}

// ─── Approval Card ───────────────────────────────────────────────────────

export function ApprovalCard({ part, onApproval }: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null)

  const handleDecision = async (decision: 'approve' | 'reject') => {
    setSubmitting(decision)
    try {
      await onApproval(part.approvalId, decision)
    } catch {
      setSubmitting(null)
    }
  }

  const isPending = part.status === 'pending'
  const isApproved = part.status === 'approved'
  const isRejected = part.status === 'rejected'
  const isExpired = part.status === 'expired'

  const config = getCardConfig(part.toolName)
  const accentStyles = PENDING_ACCENT[config.accent]

  return (
    <div
      className={cn(
        'my-2 rounded-xl border-2 p-4 transition-colors',
        isPending && `${accentStyles.border} ${accentStyles.bg}`,
        isApproved && 'border-emerald-500/30 bg-emerald-500/5',
        isRejected && 'border-destructive/30 bg-destructive/5',
        isExpired && 'border-muted-foreground/20 bg-muted/30'
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            isPending && `${accentStyles.iconBg} ${accentStyles.iconText}`,
            isApproved && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
            isRejected && 'bg-destructive/10 text-destructive',
            isExpired && 'bg-muted text-muted-foreground'
          )}
        >
          {isPending && <CardIcon icon={config.icon} />}
          {!isPending && <StatusIcon status={part.status} />}
        </div>

        <div className="flex-1 min-w-0">
          {/* Title */}
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">
              {part.title}
            </h4>
            {isApproved && (
              <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                Sent
              </span>
            )}
            {isRejected && (
              <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
                Cancelled
              </span>
            )}
            {isExpired && (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Expired
              </span>
            )}
          </div>

          {/* Tool-Specific Content Preview */}
          <ToolPreview
            toolName={part.toolName}
            toolInput={part.toolInput}
            description={part.description}
          />
        </div>
      </div>

      {/* Action Buttons */}
      {isPending && (
        <div className="mt-3 flex items-center gap-2 pl-11">
          <Button
            size="sm"
            onClick={() => handleDecision('approve')}
            disabled={submitting !== null}
            className={cn('h-8 text-white', accentStyles.button)}
          >
            {submitting === 'approve' ? (
              <span className="flex items-center gap-1.5">
                <Spinner />
                {config.approveLabel}...
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <CardIcon icon={config.icon} className="!w-3.5 !h-3.5" />
                {config.approveLabel}
              </span>
            )}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => handleDecision('reject')}
            disabled={submitting !== null}
            className="h-8"
          >
            {submitting === 'reject' ? (
              <span className="flex items-center gap-1.5">
                <Spinner />
                Cancel
              </span>
            ) : (
              'Cancel'
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
