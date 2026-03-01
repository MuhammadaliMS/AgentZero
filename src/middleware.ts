import { NextResponse, type NextRequest } from 'next/server'

const publicPaths = ['/login', '/signup', '/callback']

// All /api/* routes handle their own authentication inside Node.js route handlers.
const skipMiddlewarePaths = ['/api/']

/**
 * Decode a JWT payload without verification (base64url decode).
 * This avoids making a network call to Supabase from the edge runtime,
 * which can fail in environments with restricted DNS resolution.
 */
function decodeJwtPayload(token: string): { exp?: number; sub?: string } | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1]
    // base64url → base64
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(base64)
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Check if there's a valid (non-expired) auth session in cookies.
 * Reads the Supabase auth cookie and decodes the JWT to check expiry.
 */
function getSessionFromCookies(request: NextRequest): { userId: string } | null {
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL
    ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]
    : ''
  const cookieName = `sb-${projectRef}-auth-token`

  // Try the main cookie first
  const cookie = request.cookies.get(cookieName)
  if (cookie?.value) {
    try {
      const parsed = JSON.parse(cookie.value)
      const accessToken = parsed?.access_token
      if (accessToken) {
        const payload = decodeJwtPayload(accessToken)
        if (payload?.exp && payload.exp > Math.floor(Date.now() / 1000) && payload.sub) {
          return { userId: payload.sub }
        }
      }
    } catch {
      // Cookie exists but can't be parsed
    }
  }

  // Also check chunked cookies (Supabase splits large cookies)
  // Pattern: sb-{ref}-auth-token.0, sb-{ref}-auth-token.1, etc.
  const chunks: string[] = []
  for (let i = 0; i < 10; i++) {
    const chunk = request.cookies.get(`${cookieName}.${i}`)
    if (!chunk?.value) break
    chunks.push(chunk.value)
  }

  if (chunks.length > 0) {
    try {
      const joined = chunks.join('')
      const parsed = JSON.parse(joined)
      const accessToken = parsed?.access_token
      if (accessToken) {
        const payload = decodeJwtPayload(accessToken)
        if (payload?.exp && payload.exp > Math.floor(Date.now() / 1000) && payload.sub) {
          return { userId: payload.sub }
        }
      }
    } catch {
      // Chunked cookies can't be parsed
    }
  }

  return null
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Let all API routes bypass the edge middleware — they authenticate themselves
  if (skipMiddlewarePaths.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const session = getSessionFromCookies(request)

  // Not authenticated — redirect to login
  if (!session && !publicPaths.some(p => pathname.startsWith(p))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Authenticated but on auth pages — redirect to home
  if (session && publicPaths.some(p => pathname.startsWith(p))) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
