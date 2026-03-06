/**
 * Cron: Chief Loop v2 — Unified Hourly Intelligence Runtime
 * Schedule: 0 * * * * (top of every hour)
 *
 * 5 Phases per org:
 *   A. LOCK     — Acquire org lease, skip if busy
 *   B. GATHER   — Fetch ALL raw data (zero LLM)
 *   C. THINK    — LLM agent analyzes everything, makes decisions
 *   D. ACT      — Execute decisions, steps, graph updates, escalations
 *   E. CLOSEOUT — Persist metrics, release lease
 */

import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { timingSafeEqual } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { runChiefLoopForOrg } from '@/lib/intelligence/chief-loop'

export const runtime = 'nodejs'
export const maxDuration = 300 // 5 minutes max
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  // Auth: CRON_SECRET
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${cronSecret}`
  if (
    authHeader.length !== expected.length ||
    !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const now = new Date()

  // Get all organizations with onboarded users
  const { data: orgs } = await supabase
    .from('profiles')
    .select('org_id')
    .not('onboarded_at', 'is', null)

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, message: 'No onboarded orgs' })
  }

  const uniqueOrgIds = [...new Set(orgs.map(p => p.org_id))]

  // Respond immediately, run work in background
  const TIME_BUDGET_MS = 270_000 // 4.5 min — leave 30s safety margin before Vercel's 5-min limit
  const work = (async () => {
    const startMs = Date.now()
    let processed = 0
    for (const orgId of uniqueOrgIds) {
      const elapsed = Date.now() - startMs
      if (elapsed >= TIME_BUDGET_MS) {
        console.warn(
          `[chief-loop] Time budget exhausted after ${processed}/${uniqueOrgIds.length} orgs (${elapsed}ms). ` +
          `Skipped: ${uniqueOrgIds.slice(processed).join(', ')}`
        )
        break
      }
      try {
        const result = await runChiefLoopForOrg(orgId, now)
        console.log(
          `[chief-loop] org=${orgId}: signals=${result.signalsGathered} replans=${result.replans} ` +
          `newOutcomes=${result.newOutcomes} steps=${result.stepsExecuted} blockers=${result.blockersEscalated} ` +
          `graph=${result.graphUpdates} deferred=${result.deferredItems} cost=$${result.costUsd.toFixed(4)} (${result.durationMs}ms)`
        )
      } catch (err) {
        console.error(`[chief-loop] Fatal error for org ${orgId}:`, err)
      }
      processed++
    }
  })()

  waitUntil(work)

  return NextResponse.json({
    ok: true,
    timestamp: now.toISOString(),
    orgs_queued: uniqueOrgIds.length,
    message: 'Chief loop started in background',
  })
}
