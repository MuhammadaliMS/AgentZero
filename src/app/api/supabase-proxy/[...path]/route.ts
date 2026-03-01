import { customFetch } from '@/lib/supabase/custom-fetch'

// Force Node.js runtime (required for dns/https modules in customFetch)
export const runtime = 'nodejs'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!

// ─── Proxy Handler ─────────────────────────────────────────────────────────
// Routes browser Supabase client requests through the server's customFetch,
// which resolves DNS via public resolvers (8.8.8.8) instead of the system DNS.
//
// This fixes environments where the local DNS can't resolve *.supabase.co
// (e.g., corporate firewalls, broken routers, Pi-hole, Docker containers).
//
// Flow:
// 1. Browser Supabase client calls /api/supabase-proxy/rest/v1/integrations?...
// 2. This route strips the prefix and forwards to https://{ref}.supabase.co/rest/v1/integrations?...
// 3. customFetch resolves DNS via 8.8.8.8, connects to the IP directly with proper SNI
// 4. Response is passed back to the browser

async function proxyRequest(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const { path } = await params
  const targetPath = path.join('/')
  const searchParams = new URL(request.url).search
  const targetUrl = `${SUPABASE_URL}/${targetPath}${searchParams}`

  // Forward all headers except host (which must be the Supabase host)
  const headers: HeadersInit = {}
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    // Skip hop-by-hop headers and host
    if (lower === 'host' || lower === 'connection' || lower === 'transfer-encoding') return
    headers[key] = value
  })

  // Read body for non-GET/HEAD requests
  const hasBody = !['GET', 'HEAD'].includes(request.method)
  const body = hasBody ? await request.text() : undefined

  try {
    const response = await customFetch(targetUrl, {
      method: request.method,
      headers,
      body,
    })

    // Build response with CORS headers for the browser
    const responseHeaders = new Headers(response.headers)
    // Remove headers the proxy shouldn't forward back
    responseHeaders.delete('transfer-encoding')

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  } catch (err) {
    console.error(`[supabase-proxy] Failed to proxy ${request.method} /${targetPath}:`, err)
    return new Response(
      JSON.stringify({ error: 'Proxy request failed', message: (err as Error).message }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    )
  }
}

export const GET = proxyRequest
export const POST = proxyRequest
export const PUT = proxyRequest
export const PATCH = proxyRequest
export const DELETE = proxyRequest
export const OPTIONS = proxyRequest
