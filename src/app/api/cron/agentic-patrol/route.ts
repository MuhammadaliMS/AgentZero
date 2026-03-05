import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createAdminClient } from '@/lib/supabase/admin'
import { runAgenticScan } from '@/lib/intelligence/agentic-scanner'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Cron: Agentic Patrol Scanner
 * Schedule: 0 8,13,17 * * * (8 AM, 1 PM, 5 PM UTC)
 *
 * Tier 2 scanning — uses OpenAI Agents SDK to read connected integrations,
 * correlate signals with LLM reasoning, and discover new commitments/risks.
 *
 * Runs per-org (not per-user) — picks the primary onboarded user as scan context.
 *
 * Uses waitUntil to respond immediately (so cron-job.org doesn't timeout)
 * while the heavy LLM work continues in the background.
 */
export async function GET(request: NextRequest) {
  // ── Auth check ──────────────────────────────────────────────────────────
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Check LLM API key — supports OpenRouter (preferred) or direct OpenAI ──
  if (!process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'Neither OPENROUTER_API_KEY nor OPENAI_API_KEY configured' }, { status: 500 })
  }

  // Respond immediately — heavy work runs in background via waitUntil
  waitUntil(runAgenticPatrolBackground())

  return NextResponse.json({ ok: true, status: 'accepted' })
}

async function runAgenticPatrolBackground() {
  const admin = createAdminClient()

  // ── Get all organizations with onboarded users ──────────────────────────
  const { data: orgs } = await admin
    .from('profiles')
    .select('org_id')
    .not('onboarded_at', 'is', null)

  if (!orgs || orgs.length === 0) return

  // Deduplicate org IDs
  const uniqueOrgIds = [...new Set(orgs.map((p) => p.org_id))]

  for (const orgId of uniqueOrgIds) {
    try {
      // Get the primary onboarded user for this org (first onboarded)
      const { data: primaryUser } = await admin
        .from('profiles')
        .select('id')
        .eq('org_id', orgId)
        .not('onboarded_at', 'is', null)
        .order('onboarded_at', { ascending: true })
        .limit(1)
        .single()

      if (!primaryUser) continue

      const result = await runAgenticScan(orgId, primaryUser.id)

      if (result.skipped) {
        console.log(`[agentic-patrol] Skipped org ${orgId}: ${result.skipReason}`)
      } else {
        console.log(
          `[agentic-patrol] Completed org ${orgId}: ${result.findingsCreated} findings, ${result.durationMs}ms`
        )
      }
    } catch (err) {
      console.error(`[agentic-patrol] Error for org ${orgId}: ${(err as Error).message}`)
    }
  }
}
