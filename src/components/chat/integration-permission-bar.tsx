'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

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
  const cls = cn('shrink-0', className)

  switch (integrationKey) {
    case 'gmail':
      return (
        <svg className={cls} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect width="20" height="16" x="2" y="4" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      )
    case 'slack':
      return (
        <svg className={cls} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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
    case 'google_calendar':
      return (
        <svg className={cls} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
          <line x1="16" x2="16" y1="2" y2="6" />
          <line x1="8" x2="8" y1="2" y2="6" />
          <line x1="3" x2="21" y1="10" y2="10" />
        </svg>
      )
    case 'vanta':
      return (
        <svg className={cls} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      )
    default:
      return (
        <svg className={cls} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v6" />
          <path d="M12 18v4" />
          <circle cx="12" cy="12" r="4" />
          <path d="M4.93 4.93l4.24 4.24" />
          <path d="M14.83 14.83l4.24 4.24" />
          <path d="M2 12h6" />
          <path d="M18 12h4" />
        </svg>
      )
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
    <div className="animate-in slide-in-from-bottom-2 duration-200 border-t border-amber-500/30 bg-amber-500/5 px-4 py-3">
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
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Connecting...
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                    <polyline points="10 17 15 12 10 7" />
                    <line x1="15" x2="3" y1="12" y2="12" />
                  </svg>
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
