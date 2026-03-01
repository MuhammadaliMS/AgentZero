import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database'

// .trim() guards against trailing whitespace / newlines in env vars (common
// when values are copy-pasted into Vercel / .env files). A trailing \n in
// SUPABASE_URL would cause proxyFetch's startsWith() check to fail silently,
// sending requests directly to supabase.co instead of through the proxy.
const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
const SUPABASE_ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()

/**
 * Custom fetch that routes Supabase requests through the server-side proxy.
 *
 * Problem: Some environments have DNS resolvers that can't resolve *.supabase.co
 * (corporate firewalls, Pi-hole, broken routers, Docker containers, etc.)
 *
 * Solution: Requests to the Supabase URL are rewritten to /api/supabase-proxy/...
 * which the Next.js server handles using customFetch with public DNS (8.8.8.8).
 * Non-Supabase requests pass through to native fetch unchanged.
 */
function proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url

  // Route Supabase requests through the server-side proxy
  if (url.startsWith(SUPABASE_URL)) {
    const proxyUrl = url.replace(SUPABASE_URL, '/api/supabase-proxy')
    return globalThis.fetch(proxyUrl, init)
  }

  return globalThis.fetch(input, init)
}

export function createClient() {
  return createBrowserClient<Database>(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      global: {
        fetch: proxyFetch,
      },
    }
  )
}
