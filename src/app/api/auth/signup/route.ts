import { NextResponse } from 'next/server'
import { httpsRequest } from '@/lib/supabase/custom-fetch'

// Force Node.js runtime
export const runtime = 'nodejs'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export async function POST(request: Request) {
  try {
    const { email, password, fullName, orgName } = await request.json()

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    const result = await httpsRequest(`${SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        email,
        password,
        data: {
          full_name: fullName,
          org_name: orgName,
        },
      }),
    })

    if (result.status >= 400) {
      const message = result.data?.msg || result.data?.message || result.data?.error_description || 'Signup failed'
      return NextResponse.json({ error: message }, { status: result.status })
    }

    // Build response with auth cookies
    const response = NextResponse.json({ success: true, user: result.data?.user })

    // Set auth cookies from the Supabase response
    const accessToken = result.data?.access_token
    const refreshToken = result.data?.refresh_token
    if (accessToken && refreshToken) {
      const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
      const cookieBase = `sb-${projectRef}-auth-token`

      response.cookies.set(`${cookieBase}`, JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'bearer',
        expires_in: result.data?.expires_in || 3600,
        expires_at: result.data?.expires_at || Math.floor(Date.now() / 1000) + 3600,
        user: result.data?.user,
      }), {
        path: '/',
        httpOnly: false,
        sameSite: 'lax',
        secure: false, // dev
        maxAge: result.data?.expires_in || 3600,
      })
    }

    return response
  } catch (err) {
    console.error('Signup error:', err)
    return NextResponse.json(
      { error: 'An unexpected error occurred' },
      { status: 500 }
    )
  }
}
