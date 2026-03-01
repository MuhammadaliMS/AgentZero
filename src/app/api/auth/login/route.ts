import { NextResponse } from 'next/server'

// Force Node.js runtime
export const runtime = 'nodejs'

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
const SUPABASE_ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json()

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars')
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      )
    }

    // Use standard fetch — works on Vercel and most environments.
    // The custom DNS resolver (httpsRequest) was only needed for local
    // environments with broken DNS; Vercel resolves supabase.co fine.
    const supabaseRes = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ email, password }),
      }
    )

    const data = await supabaseRes.json()

    if (!supabaseRes.ok) {
      const message = data?.msg || data?.message || data?.error_description || 'Login failed'
      return NextResponse.json({ error: message }, { status: supabaseRes.status })
    }

    // Build response with auth cookies
    const response = NextResponse.json({ success: true, user: data?.user })

    const accessToken = data?.access_token
    const refreshToken = data?.refresh_token
    if (accessToken && refreshToken) {
      const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
      const cookieBase = `sb-${projectRef}-auth-token`

      response.cookies.set(`${cookieBase}`, JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'bearer',
        expires_in: data?.expires_in || 3600,
        expires_at: data?.expires_at || Math.floor(Date.now() / 1000) + 3600,
        user: data?.user,
      }), {
        path: '/',
        httpOnly: false,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: data?.expires_in || 3600,
      })
    }

    return response
  } catch (err) {
    console.error('Login error:', err)
    return NextResponse.json(
      { error: 'An unexpected error occurred' },
      { status: 500 }
    )
  }
}
