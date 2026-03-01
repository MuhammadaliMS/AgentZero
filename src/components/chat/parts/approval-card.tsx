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

  return (
    <div
      className={cn(
        'my-2 rounded-xl border-2 p-4 transition-colors',
        isPending && 'border-amber-500/40 bg-amber-500/5',
        isApproved && 'border-emerald-500/30 bg-emerald-500/5',
        isRejected && 'border-destructive/30 bg-destructive/5',
        isExpired && 'border-muted-foreground/20 bg-muted/30'
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        {/* Shield Icon */}
        <div
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            isPending && 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
            isApproved && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
            isRejected && 'bg-destructive/10 text-destructive',
            isExpired && 'bg-muted text-muted-foreground'
          )}
        >
          {isPending && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
          )}
          {isApproved && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          )}
          {isRejected && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
              <line x1="15" x2="9" y1="9" y2="15" />
              <line x1="9" x2="15" y1="9" y2="15" />
            </svg>
          )}
          {isExpired && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {/* Title */}
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">
              {part.title}
            </h4>
            {isApproved && (
              <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                Approved
              </span>
            )}
            {isRejected && (
              <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
                Rejected
              </span>
            )}
            {isExpired && (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Expired
              </span>
            )}
          </div>

          {/* Description */}
          {part.description && (
            <div className="mt-1.5 text-xs text-muted-foreground prose prose-xs dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {part.description}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      {isPending && (
        <div className="mt-3 flex items-center gap-2 pl-11">
          <Button
            size="sm"
            onClick={() => handleDecision('approve')}
            disabled={submitting !== null}
            className="h-8 bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {submitting === 'approve' ? (
              <span className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Approving...
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Approve
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
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Rejecting...
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" x2="6" y1="6" y2="18" />
                  <line x1="6" x2="18" y1="6" y2="18" />
                </svg>
                Reject
              </span>
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
