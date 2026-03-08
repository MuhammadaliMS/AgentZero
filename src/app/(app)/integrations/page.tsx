'use client'

import { useState } from 'react'
import { IntegrationCatalog } from '@/components/integrations/integration-catalog'
import { useIntegrations } from '@/hooks/use-integrations'
import { Button } from '@/components/ui/button'
import { Layers, AlertCircle, Plug } from 'lucide-react'

type ViewMode = 'all' | 'connected'

export default function IntegrationsPage() {
  const { integrations, loading, error, connectedKeys, refresh } = useIntegrations()
  const [viewMode, setViewMode] = useState<ViewMode>('all')

  const connectedIntegrations = integrations.filter((i) => i.connected)
  const disconnectedIntegrations = integrations.filter((i) => !i.connected)

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-10">
      {/* Header */}
      <header className="mb-8 sm:mb-10">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
            <Layers className="h-5 w-5 text-primary" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
            <p className="text-[13px] text-muted-foreground leading-none mt-0.5">
              Connect your tools to unlock your Captain&apos;s full capabilities
            </p>
          </div>
        </div>
      </header>

      {/* Error Banner */}
      {error && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm dark:border-red-800/50 dark:bg-red-950/20">
          <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
          <p className="text-red-700 dark:text-red-400 flex-1">{error}</p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-red-700 hover:text-red-800 dark:text-red-400 cursor-pointer"
            onClick={refresh}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Toolbar */}
      <div className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        {/* Stats */}
        <div className="flex items-center gap-2.5">
          {loading ? (
            <div className="h-6 w-32 animate-pulse rounded-md bg-muted/50" />
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-200/60 dark:ring-emerald-800/30">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {connectedKeys.length} connected
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {integrations.length - connectedKeys.length} available
              </span>
            </>
          )}
        </div>

        {/* Filter pills */}
        <nav className="flex gap-0.5 rounded-lg bg-muted/50 p-0.5" role="tablist">
          {(['all', 'connected'] as const).map(f => (
            <button
              key={f}
              role="tab"
              aria-selected={viewMode === f}
              onClick={() => setViewMode(f)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium cursor-pointer transition-all duration-200
                ${viewMode === f
                  ? 'bg-card text-foreground shadow-sm ring-1 ring-border/60'
                  : 'text-muted-foreground hover:text-foreground'
                }`}
            >
              {f === 'all' ? 'All' : 'Connected'}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      {viewMode === 'connected' ? (
        <>
          {connectedIntegrations.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/40 ring-1 ring-border/30">
                <Plug className="h-6 w-6 text-muted-foreground/40" />
              </div>
              <p className="text-sm font-medium text-foreground/60 mb-0.5">No integrations connected yet</p>
              <p className="text-xs text-muted-foreground mb-4">
                Connect your first tool to get started
              </p>
              <Button
                variant="outline"
                size="sm"
                className="text-xs cursor-pointer"
                onClick={() => setViewMode('all')}
              >
                Browse available integrations
              </Button>
            </div>
          ) : (
            <div className="space-y-6">
              <IntegrationCatalog
                integrations={connectedIntegrations}
                loading={loading}
                onConnected={refresh}
                showManagement
              />

              {disconnectedIntegrations.length > 0 && (
                <div className="text-center pt-6 border-t border-border/40">
                  <p className="text-xs text-muted-foreground mb-2">
                    {disconnectedIntegrations.length} more integrations available
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-primary hover:text-primary cursor-pointer"
                    onClick={() => setViewMode('all')}
                  >
                    View all integrations
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <IntegrationCatalog
          integrations={integrations}
          loading={loading}
          onConnected={refresh}
          showManagement
        />
      )}
    </div>
  )
}
