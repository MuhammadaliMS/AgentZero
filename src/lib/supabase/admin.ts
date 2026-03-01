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
