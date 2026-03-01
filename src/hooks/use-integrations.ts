'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Database } from '@/types/database'
import type { IntegrationWithStatus } from '@/types/integrations'

type IntegrationRow = Database['public']['Tables']['integrations']['Row']

export function useIntegrations() {
  const [integrations, setIntegrations] = useState<IntegrationWithStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Stable client reference — createBrowserClient uses an internal singleton,
  // but wrapping in useMemo ensures the reference is stable for useCallback deps.
  const supabase = useMemo(() => createClient(), [])

  const fetchIntegrations = useCallback(async () => {
    try {
      setError(null)

      // Get all integrations from catalog
      const { data: rawCatalog, error: catalogError } = await supabase
        .from('integrations')
        .select('*')
        .eq('status', 'active')
        .order('display_order')

      if (catalogError) {
        console.error('[useIntegrations] Failed to fetch catalog:', catalogError.message, catalogError.code)
        setError(`Failed to load integrations: ${catalogError.message}`)
        setLoading(false)
        return
      }

      const catalog = (rawCatalog || []) as IntegrationRow[]

      // Get connected integrations for this org (RLS scopes to org_id)
      const { data: connected, error: connectedError } = await supabase
        .from('organization_integrations')
        .select('*, integrations!inner(key)')
        .eq('is_active', true)

      if (connectedError) {
        console.error('[useIntegrations] Failed to fetch connected:', connectedError.message, connectedError.code)
        // Non-fatal — show catalog without connection status
      }

      const connectedMap = new Map(
        (connected as Array<{ id: string; health_status: string; user_metadata: unknown; integrations: { key: string } }> ?? []).map(c => [
          c.integrations.key,
          c,
        ])
      )

      const merged: IntegrationWithStatus[] = catalog
        .filter(i => !i.parent_integration_id)
        .map(i => {
          const conn = connectedMap.get(i.key)
          return {
            ...i,
            manifest: i.manifest as IntegrationWithStatus['manifest'],
            instructions: i.instructions as IntegrationWithStatus['instructions'],
            connected: !!conn,
            health_status: conn?.health_status,
            org_integration_id: conn?.id,
            user_metadata: conn?.user_metadata as Record<string, unknown> | null,
          }
        })

      setIntegrations(merged)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error fetching integrations'
      console.error('[useIntegrations] Unexpected error:', message)
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    fetchIntegrations()
  }, [fetchIntegrations])

  // Listen for postMessage from OAuth popup
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === 'integration_connected') {
        fetchIntegrations()
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [fetchIntegrations])

  const connectedKeys = integrations.filter(i => i.connected).map(i => i.key)

  return { integrations, loading, error, connectedKeys, refresh: fetchIntegrations }
}
