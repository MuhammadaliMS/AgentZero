'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { IntegrationWithStatus } from '@/types/integrations'
import { ApiKeyForm } from '@/components/onboarding/api-key-form'
import { toast } from 'sonner'

const CATEGORY_LABELS: Record<string, string> = {
  email: 'Email',
  messenger: 'Messaging',
  calendar: 'Calendar',
  risk_and_compliance: 'Compliance',
  endpoint_detection: 'Security',
  vulnerability_management: 'Security',
  developer_tools: 'Dev Tools',
  content_management: 'Content',
  meeting_intelligence: 'Meetings',
}

function HealthDot({ status }: { status?: string }) {
  // DB constraint: health_status IN ('unknown', 'healthy', 'degraded', 'error')
  const color =
    status === 'healthy'
      ? 'bg-green-500'
      : status === 'error'
      ? 'bg-red-500'
      : status === 'degraded'
      ? 'bg-yellow-500'
      : 'bg-gray-400' // 'unknown' or undefined

  const label =
    status === 'healthy'
      ? 'Healthy'
      : status === 'error'
      ? 'Connection error'
      : status === 'degraded'
      ? 'Degraded'
      : 'Unknown status'

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="relative flex h-2.5 w-2.5">
            {status === 'healthy' && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-40" />
            )}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${color}`} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="text-xs">{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function IntegrationCard({
  integration,
  onConnected,
  showManagement = false,
}: {
  integration: IntegrationWithStatus
  onConnected?: () => void
  showManagement?: boolean
}) {
  const [connecting, setConnecting] = useState(false)
  const [showApiKeyForm, setShowApiKeyForm] = useState(false)
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [testing, setTesting] = useState(false)

  async function handleConnect() {
    if (integration.auth_type === 'api_key') {
      setShowApiKeyForm(true)
      return
    }

    setConnecting(true)
    try {
      const response = await fetch(`/api/integrations/${integration.key}/oauth-url`)
      const { url } = await response.json()

      const popup = window.open(url, `connect_${integration.key}`, 'width=600,height=700')

      const timer = setInterval(() => {
        if (popup?.closed) {
          clearInterval(timer)
          setConnecting(false)
          onConnected?.()
        }
      }, 500)
    } catch {
      setConnecting(false)
      toast.error('Failed to start connection flow')
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true)
    try {
      const response = await fetch(`/api/integrations/${integration.key}/disconnect`, {
        method: 'POST',
      })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to disconnect')
      }
      toast.success(`${integration.name} disconnected`)
      setShowDisconnectDialog(false)
      onConnected?.()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setDisconnecting(false)
    }
  }

  async function handleTestConnection() {
    setTesting(true)
    try {
      const response = await fetch(`/api/integrations/${integration.key}/test`)
      const data = await response.json()
      if (data.healthy) {
        toast.success(`${integration.name} connection is healthy`)
      } else {
        toast.error(`${integration.name}: ${data.error || 'Connection issue detected'}`)
      }
      onConnected?.()
    } catch {
      toast.error('Failed to test connection')
    } finally {
      setTesting(false)
    }
  }

  function handleReconnect() {
    if (integration.auth_type === 'oauth2') {
      handleConnect()
    } else {
      setShowApiKeyForm(true)
    }
  }

  const metadata = integration.user_metadata as Record<string, string> | null
  const connectedAccount =
    metadata?.connected_email ||
    metadata?.workspace_name ||
    metadata?.account_name ||
    null

  return (
    <>
      <Card
        className={`transition-all ${
          integration.connected
            ? integration.health_status === 'error'
              ? 'border-red-500/30 bg-red-50/30 dark:bg-red-950/5'
              : 'border-green-500/30 bg-green-50/30 dark:bg-green-950/5'
            : 'hover:border-foreground/20'
        }`}
      >
        <CardContent className="flex items-center gap-3 p-4">
          {/* Icon */}
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg font-bold ${
              integration.connected
                ? 'bg-primary/10 text-primary'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {integration.name[0]}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-medium text-sm">{integration.name}</p>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {CATEGORY_LABELS[integration.category] || integration.category}
              </Badge>
              {integration.connected && <HealthDot status={integration.health_status} />}
            </div>
            {integration.connected && connectedAccount ? (
              <p className="text-xs text-muted-foreground truncate">{connectedAccount}</p>
            ) : (
              <p className="text-xs text-muted-foreground truncate">
                {integration.description}
              </p>
            )}
          </div>

          {/* Actions */}
          {integration.connected ? (
            <div className="flex shrink-0 items-center gap-2">
              {showManagement ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1">
                      <span className="hidden sm:inline">Manage</span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onClick={handleTestConnection} disabled={testing}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                        <polyline points="22 4 12 14.01 9 11.01" />
                      </svg>
                      {testing ? 'Testing...' : 'Test Connection'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleReconnect}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2">
                        <polyline points="23 4 23 10 17 10" />
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                      </svg>
                      Reconnect
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setShowDisconnectDialog(true)}
                      className="text-destructive focus:text-destructive"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Badge variant="outline" className="shrink-0 border-green-500 text-green-600">
                  Connected
                </Badge>
              )}
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={handleConnect}
              disabled={connecting}
              className="shrink-0"
            >
              {connecting ? 'Connecting...' : 'Connect'}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* API Key Form Dialog */}
      {showApiKeyForm && (
        <ApiKeyForm
          integration={integration}
          open={showApiKeyForm}
          onClose={() => setShowApiKeyForm(false)}
          onConnected={() => {
            setShowApiKeyForm(false)
            onConnected?.()
          }}
        />
      )}

      {/* Disconnect Confirmation Dialog */}
      <Dialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect {integration.name}?</DialogTitle>
            <DialogDescription>
              Your Captain will lose access to {integration.name} data. You can reconnect
              at any time, but historical context from this integration may not be restored.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowDisconnectDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={disconnecting}
            >
              {disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
