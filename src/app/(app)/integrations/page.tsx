'use client'

import { useState } from 'react'
import { IntegrationCatalog } from '@/components/integrations/integration-catalog'
import { useIntegrations } from '@/hooks/use-integrations'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

type ViewMode = 'all' | 'connected'

export default function IntegrationsPage() {
  const { integrations, loading, error, connectedKeys, refresh } = useIntegrations()
  const [viewMode, setViewMode] = useState<ViewMode>('all')

  const connectedIntegrations = integrations.filter((i) => i.connected)
  const disconnectedIntegrations = integrations.filter((i) => !i.connected)

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect your tools to unlock your Captain&apos;s full capabilities.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/20 dark:text-red-400">
          <p>{error}</p>
          <Button variant="link" size="sm" className="h-auto p-0 text-red-700 dark:text-red-400" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      {/* Stats bar */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {loading ? (
            <Badge variant="outline" className="gap-1 px-2.5 py-1">
              <span className="text-xs text-muted-foreground">Loading...</span>
            </Badge>
          ) : (
            <>
              <Badge variant="secondary" className="gap-1 px-2.5 py-1">
                <span className="font-mono text-xs">{connectedKeys.length}</span>
                <span className="text-xs">connected</span>
              </Badge>
              <Badge variant="outline" className="gap-1 px-2.5 py-1">
                <span className="font-mono text-xs">{integrations.length - connectedKeys.length}</span>
                <span className="text-xs">available</span>
              </Badge>
            </>
          )}
        </div>

        {/* View toggle */}
        <div className="flex items-center rounded-lg border p-0.5">
          <Button
            variant={viewMode === 'all' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('all')}
            className="h-7 px-3 text-xs"
          >
            All
          </Button>
          <Button
            variant={viewMode === 'connected' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setViewMode('connected')}
            className="h-7 px-3 text-xs"
          >
            Connected
          </Button>
        </div>
      </div>

      {viewMode === 'connected' ? (
        <>
          {/* Connected integrations with management controls */}
          {connectedIntegrations.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">No integrations connected yet.</p>
              <Button
                variant="link"
                size="sm"
                className="mt-2"
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
                <>
                  <Separator />
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground">
                      {disconnectedIntegrations.length} more integrations available
                    </p>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => setViewMode('all')}
                    >
                      View all integrations
                    </Button>
                  </div>
                </>
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
