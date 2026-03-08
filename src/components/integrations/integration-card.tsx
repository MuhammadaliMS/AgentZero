'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
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
import { CheckCircle, ChevronDown, RefreshCw, X, TestTubeDiagonal, ArrowRight } from 'lucide-react'
import type { IntegrationWithStatus } from '@/types/integrations'
import { ApiKeyForm } from '@/components/onboarding/api-key-form'
import { toast } from 'sonner'

function HealthDot({ status }: { status?: string }) {
  const config: Record<string, { color: string; ping: string; label: string }> = {
    healthy: { color: 'bg-emerald-500', ping: 'bg-emerald-400', label: 'Healthy' },
    error: { color: 'bg-red-500', ping: '', label: 'Connection error' },
    degraded: { color: 'bg-amber-500', ping: '', label: 'Degraded' },
  }
  const { color, ping, label } = config[status || ''] || { color: 'bg-slate-400', ping: '', label: 'Unknown status' }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="relative flex h-2 w-2">
            {ping && (
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${ping} opacity-40`} />
            )}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
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
      <div
        className={`group flex items-center gap-3 rounded-xl border p-3.5 transition-all duration-200 hover:shadow-md cursor-default ${
          integration.connected
            ? integration.health_status === 'error'
              ? 'border-red-200 dark:border-red-800/40 bg-red-50/50 dark:bg-red-950/10'
              : 'border-emerald-200/60 dark:border-emerald-800/30 bg-emerald-50/30 dark:bg-emerald-950/10'
            : 'border-border/50 hover:border-border bg-card'
        }`}
      >
        {/* Icon */}
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-base font-bold transition-colors ${
            integration.connected
              ? 'bg-primary/10 text-primary'
              : 'bg-muted text-muted-foreground group-hover:bg-primary/5 group-hover:text-primary/70'
          }`}
        >
          {integration.name[0]}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium text-sm">{integration.name}</p>
            {integration.connected && <HealthDot status={integration.health_status} />}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {integration.connected && connectedAccount
              ? connectedAccount
              : integration.description}
          </p>
        </div>

        {/* Actions */}
        {integration.connected ? (
          <div className="flex shrink-0 items-center gap-2">
            {showManagement ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 px-2.5 text-xs rounded-lg cursor-pointer border-border/60"
                  >
                    <span className="hidden sm:inline">Manage</span>
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={handleTestConnection} disabled={testing} className="cursor-pointer">
                    <TestTubeDiagonal className="mr-2 h-3.5 w-3.5" />
                    {testing ? 'Testing...' : 'Test Connection'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleReconnect} className="cursor-pointer">
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    Reconnect
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setShowDisconnectDialog(true)}
                    className="text-destructive focus:text-destructive cursor-pointer"
                  >
                    <X className="mr-2 h-3.5 w-3.5" />
                    Disconnect
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 dark:border-emerald-800/40 bg-emerald-50 dark:bg-emerald-950/20 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                <CheckCircle className="h-3 w-3" />
                Connected
              </span>
            )}
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={handleConnect}
            disabled={connecting}
            className="shrink-0 h-8 gap-1.5 rounded-lg text-xs cursor-pointer hover:bg-primary hover:text-primary-foreground hover:border-primary transition-colors"
          >
            {connecting ? (
              'Connecting...'
            ) : (
              <>
                Connect
                <ArrowRight className="h-3 w-3" />
              </>
            )}
          </Button>
        )}
      </div>

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
            <Button variant="outline" onClick={() => setShowDisconnectDialog(false)} className="cursor-pointer">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="cursor-pointer"
            >
              {disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
