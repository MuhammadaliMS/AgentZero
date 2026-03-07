'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Mail, Hash, Calendar, ShieldCheck, Plug, Loader2, Check } from 'lucide-react'
import type { IntegrationPromptPart as IntegrationPromptPartType } from '@/types/chat'

interface IntegrationPromptCardProps {
  part: IntegrationPromptPartType
  onConnect: (integrationKey: string) => void
}

// ─── Integration Icons ───────────────────────────────────────────────────

function IntegrationIcon({ integrationKey, className }: { integrationKey: string; className?: string }) {
  const cls = cn('shrink-0 h-5 w-5', className)

  switch (integrationKey) {
    case 'gmail':
      return <Mail className={cls} />
    case 'slack':
      return <Hash className={cls} />
    case 'google_calendar':
      return <Calendar className={cls} />
    case 'vanta':
      return <ShieldCheck className={cls} />
    default:
      return <Plug className={cls} />
  }
}

// ─── Integration Prompt Card ─────────────────────────────────────────────

export function IntegrationPromptCard({ part, onConnect }: IntegrationPromptCardProps) {
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const popupRef = useRef<Window | null>(null)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  const handleConnect = useCallback(async () => {
    setConnecting(true)
    setError(null)

    try {
      // Get OAuth URL from the integration endpoint
      const response = await fetch(`/api/integrations/${part.integrationKey}/oauth-url`)
      if (!response.ok) {
        let errMsg = `Failed to connect (${response.status})`
        try {
          const data = await response.json()
          if (data.error) errMsg = data.error
        } catch {
          // Response body was not JSON — use status-based message
        }
        throw new Error(errMsg)
      }

      const { url } = await response.json()

      // Calculate popup position (centered)
      const width = 600
      const height = 700
      const left = window.screenX + (window.outerWidth - width) / 2
      const top = window.screenY + (window.outerHeight - height) / 2

      // Open OAuth popup
      popupRef.current = window.open(
        url,
        `oauth_${part.integrationKey}`,
        `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes`
      )

      if (!popupRef.current) {
        throw new Error('Popup was blocked. Please allow popups for this site.')
      }

      // Poll for popup close
      timerRef.current = setInterval(() => {
        if (popupRef.current?.closed) {
          if (timerRef.current) clearInterval(timerRef.current)
          timerRef.current = null
          popupRef.current = null
          setConnecting(false)
          // Notify parent that connection is complete
          onConnect(part.integrationKey)
        }
      }, 500)

      // Timeout after 5 minutes
      setTimeout(() => {
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
          if (popupRef.current && !popupRef.current.closed) {
            popupRef.current.close()
          }
          popupRef.current = null
          setConnecting(false)
        }
      }, 5 * 60 * 1000)
    } catch (err) {
      setError((err as Error).message)
      setConnecting(false)
    }
  }, [part.integrationKey, onConnect])

  const isPending = part.status === 'pending'
  const isConnected = part.status === 'connected'
  const isDismissed = part.status === 'dismissed'

  return (
    <div
      className={cn(
        'my-2 rounded-xl border-2 p-4 transition-colors',
        isPending && 'border-blue-500/40 bg-blue-500/5',
        isConnected && 'border-emerald-500/30 bg-emerald-500/5',
        isDismissed && 'border-muted-foreground/20 bg-muted/30'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Integration Icon */}
        <div
          className={cn(
            'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
            isPending && 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
            isConnected && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
            isDismissed && 'bg-muted text-muted-foreground'
          )}
        >
          <IntegrationIcon integrationKey={part.integrationKey} />
        </div>

        <div className="flex-1 min-w-0">
          {/* Title */}
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">
              {isConnected
                ? `${part.integrationName} Connected`
                : `Connect ${part.integrationName}`}
            </h4>
            {isConnected && (
              <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                <Check className="mr-0.5 h-3 w-3" />
                Connected
              </span>
            )}
          </div>

          {/* Reason */}
          {part.reason && isPending && (
            <p className="mt-1 text-xs text-muted-foreground">
              {part.reason}
            </p>
          )}

          {/* Connected confirmation */}
          {isConnected && (
            <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
              {part.integrationName} is now connected. The agent will continue processing your request.
            </p>
          )}

          {/* Error */}
          {error && (
            <p className="mt-1 text-xs text-destructive">{error}</p>
          )}
        </div>
      </div>

      {/* Connect Button */}
      {isPending && (
        <div className="mt-3 pl-[52px]">
          <Button
            size="sm"
            onClick={handleConnect}
            disabled={connecting}
            className="h-8 bg-blue-600 hover:bg-blue-700 text-white"
          >
            {connecting ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Connecting...
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <Plug className="h-3.5 w-3.5" />
                Connect {part.integrationName}
              </span>
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
