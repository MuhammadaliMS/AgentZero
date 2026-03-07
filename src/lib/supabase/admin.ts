import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { customFetch } from './custom-fetch'

export function createAdminClient() {
  return createClient<Database>(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim(),
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        fetch: customFetch,
      },
    }
  )
}

/**
 * Untyped admin client for tables not yet in the auto-generated Database type
 * (e.g., meeting_* tables from migration 022).
 * Remove this once you run `supabase gen types` to regenerate database.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createUntypedAdminClient(): any {
  return createAdminClient()
}
