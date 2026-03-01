'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'

interface OAuthConnectButtonProps {
  integrationKey: string
  integrationName: string
  onConnected: () => void
  variant?: 'default' | 'outline' | 'secondary'
  size?: 'default' | 'sm' | 'lg'
  className?: string
}

export function OAuthConnectButton({
  integrationKey,
  integrationName,
  onConnected,
  variant = 'default',
  size = 'default',
  className,
}: OAuthConnectButtonProps) {
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
      const response = await fetch(`/api/integrations/${integrationKey}/oauth-url`)
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to get authorization URL')
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
        `oauth_${integrationKey}`,
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
          // Notify parent — connection state will be re-fetched
          onConnected()
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
  }, [integrationKey, onConnected])

  return (
    <div>
      <Button
        variant={variant}
        size={size}
        onClick={handleConnect}
        disabled={connecting}
        className={className}
      >
        {connecting ? (
          <span className="flex items-center gap-2">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Connecting {integrationName}...
          </span>
        ) : (
          `Connect ${integrationName}`
        )}
      </Button>
      {error && (
        <p className="mt-1 text-xs text-destructive">{error}</p>
      )}
    </div>
  )
}
