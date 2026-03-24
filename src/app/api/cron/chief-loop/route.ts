/**
 * Cron: Chief Loop v3 — Phase-Chained Intelligence Runtime
 * Schedule: 0 * * * * (top of every hour)
 *
 * Supports 3 execution modes:
 *   1. Chained (default): Phase 1 → HTTP trigger → Phase 2 → HTTP trigger → Phase 3
 *      Each phase gets its own 300s Vercel budget = 900s total.
 *   2. Sync (?sync=true): All 3 phases run inline (local dev only, no HTTP chaining).
 *   3. Legacy (?legacy=true): Original single-call mode via runChiefLoopForOrg.
 *
 * Phase routing via query params:
 *   ?phase=2&leaseId=xxx  — Continue to Phase 2 for a specific lease
 *   ?phase=3&leaseId=xxx  — Continue to Phase 3 for a specific lease
 *   (no phase param)      — Start Phase 1 for all orgs
 */

import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { timingSafeEqual } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'
export const maxDuration = 300 // 5 minutes max per phase
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

  const url = new URL(request.url)
  const phase = url.searchParams.get('phase')
  const leaseId = url.searchParams.get('leaseId')
  const isSync = url.searchParams.get('sync') === 'true'
  const isLegacy = url.searchParams.get('legacy') === 'true'
  const now = new Date()

  // ── Phase 2 or 3: Continue a chained run ──
  if ((phase === '2' || phase === '3') && leaseId) {
    const phaseNum = parseInt(phase)
    console.log(`[chief-loop] Continuing phase ${phaseNum} for lease ${leaseId}`)

    const runPhase = async () => {
      if (phaseNum === 2) {
        const { runChiefPhase2 } = await import('@/lib/intelligence/chief-loop')
        return runChiefPhase2(leaseId)
      } else {
        const { runChiefPhase3 } = await import('@/lib/intelligence/chief-loop')
        return runChiefPhase3(leaseId)
      }
    }

    if (isSync) {
      const result = await runPhase()
      return NextResponse.json({ ok: true, phase: phaseNum, leaseId, mode: 'sync', result })
    }

    waitUntil(runPhase())
    return NextResponse.json({
      ok: true,
      phase: phaseNum,
      leaseId,
      message: `Phase ${phaseNum} started in background`,
    })
  }

  // ── Phase 1 (or full run): Start for all orgs ──

  const supabase = createAdminClient()

  const { data: orgs } = await supabase
    .from('profiles')
    .select('org_id')
    .not('onboarded_at', 'is', null)

  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, message: 'No onboarded orgs' })
  }

  const uniqueOrgIds = [...new Set(orgs.map(p => p.org_id))]

  // ── Legacy mode: single-call (backwards compat) ──
  if (isLegacy) {
    const { runChiefLoopForOrg } = await import('@/lib/intelligence/chief-loop')

    const runLoop = async () => {
      const results: Array<{ orgId: string; result?: unknown; error?: string }> = []
      for (const orgId of uniqueOrgIds) {
        try {
          const result = await runChiefLoopForOrg(orgId, now)
          results.push({ orgId, result })
        } catch (err) {
          results.push({ orgId, error: (err as Error).message })
        }
      }
      return results
    }

    if (isSync) {
      const results = await runLoop()
      return NextResponse.json({ ok: true, timestamp: now.toISOString(), mode: 'legacy-sync', results })
    }

    waitUntil(runLoop())
    return NextResponse.json({ ok: true, timestamp: now.toISOString(), mode: 'legacy', orgs_queued: uniqueOrgIds.length })
  }

  // ── Sync mode: run all 3 phases inline (local dev) ──
  if (isSync) {
    const { runChiefLoopChainedSync } = await import('@/lib/intelligence/chief-loop')
    const results: Array<{ orgId: string; result?: unknown; error?: string }> = []

    for (const orgId of uniqueOrgIds) {
      try {
        const result = await runChiefLoopChainedSync(orgId, now)
        console.log(
          `[chief-loop] org=${orgId}: chained sync complete in ${result.totalDurationMs}ms, ` +
          `phases: ${result.phases.map(p => `p${p.phase}=${p.durationMs}ms${p.error ? '(ERR)' : ''}`).join(' → ')}`
        )
        results.push({ orgId, result })
      } catch (err) {
        console.error(`[chief-loop] Fatal error for org ${orgId}:`, err)
        results.push({ orgId, error: (err as Error).message })
      }
    }

    return NextResponse.json({
      ok: true,
      timestamp: now.toISOString(),
      mode: 'chained-sync',
      results,
    })
  }

  // ── Default: Chained mode — start Phase 1 for each org (self-triggers Phase 2 → 3) ──
  const { runChiefPhase1 } = await import('@/lib/intelligence/chief-loop')

  const runPhase1ForAllOrgs = async () => {
    const results: Array<{ orgId: string; result?: unknown; error?: string }> = []
    for (const orgId of uniqueOrgIds) {
      try {
        const result = await runChiefPhase1(orgId, now)
        console.log(
          `[chief-loop] org=${orgId}: Phase 1 done in ${result.durationMs}ms, ` +
          `nextPhase=${result.nextPhase ?? 'none'}${result.error ? ` error=${result.error}` : ''}`
        )
        results.push({ orgId, result })
      } catch (err) {
        console.error(`[chief-loop] Phase 1 fatal error for org ${orgId}:`, err)
        results.push({ orgId, error: (err as Error).message })
      }
    }
    return results
  }

  waitUntil(runPhase1ForAllOrgs())

  return NextResponse.json({
    ok: true,
    timestamp: now.toISOString(),
    mode: 'chained',
    orgs_queued: uniqueOrgIds.length,
    message: 'Phase 1 started — will self-chain to Phase 2 → 3',
  })
}
