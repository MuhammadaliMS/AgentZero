'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * Subscribe to realtime changes on a Supabase table
 */
export function useRealtime(
  table: string,
  filter: string | undefined,
  callback: (payload: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }) => void
) {
  const supabase = createClient()

  useEffect(() => {
    let channel = supabase
      .channel(`${table}-changes`)
      .on(
        'postgres_changes' as 'system',
        {
          event: '*',
          schema: 'public',
          table,
          ...(filter ? { filter } : {}),
        } as unknown as { event: string },
        (payload: unknown) => {
          callback(payload as { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> })
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [supabase, table, filter, callback])
}
