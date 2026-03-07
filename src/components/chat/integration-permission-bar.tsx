'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Mail, Hash, Calendar, ShieldCheck, Plug, Loader2, LogIn } from 'lucide-react'

// ─── Props ─────────────────────────────────────────────────────────────

interface IntegrationPermissionBarProps {
  integration: {
    approvalId: string
    integrationKey: string
    integrationName: string
    reason: string
  }
  onConnect: (approvalId: string) => void
  onDismiss: (approvalId: string) => void
}

// ─── Integration Icons (reused from integration-prompt-card) ────────────

function IntegrationIcon({ integrationKey, className }: { integrationKey: string; className?: string }) {
  const cls = cn('shrink-0 h-[18px] w-[18px]', className)

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

// ─── Integration Permission Bar ────────────────────────────────────────
// Appears above the chat input when the agent is blocked waiting for
// an integration connection. Similar to Claude Code's permission prompt.

export function IntegrationPermissionBar({
  integration,
  onConnect,
  onDismiss,
}: IntegrationPermissionBarProps) {
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
      const response = await fetch(`/api/integrations/${integration.integrationKey}/oauth-url`)
      if (!response.ok) {
        let errMsg = `Failed to connect (${response.status})`
        try {
          const data = await response.json()
          if (data.error) errMsg = data.error
        } catch {
          // Response body was not JSON
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
        `oauth_${integration.integrationKey}`,
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
          // Notify parent — resolves the blocking promise via /api/agent/approve
          onConnect(integration.approvalId)
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
  }, [integration.integrationKey, integration.approvalId, onConnect])

  const handleDismiss = useCallback(() => {
    onDismiss(integration.approvalId)
  }, [integration.approvalId, onDismiss])

  return (
    <div className="animate-in slide-in-from-bottom-2 duration-200 border-t border-l-2 border-primary border-t-amber-500/30 bg-amber-500/5 px-4 py-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-3">
          {/* Icon */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <IntegrationIcon integrationKey={integration.integrationKey} />
          </div>

          {/* Text */}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              Connect {integration.integrationName} to continue
            </p>
            {integration.reason && (
              <p className="text-xs text-muted-foreground truncate">
                {integration.reason}
              </p>
            )}
            {error && (
              <p className="text-xs text-destructive mt-0.5">{error}</p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              disabled={connecting}
              className="h-8 text-xs text-muted-foreground hover:text-foreground"
            >
              Skip
            </Button>
            <Button
              size="sm"
              onClick={handleConnect}
              disabled={connecting}
              className="h-8 bg-amber-600 hover:bg-amber-700 text-white"
            >
              {connecting ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Connecting...
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <LogIn className="h-3.5 w-3.5" />
                  Connect
                </span>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
