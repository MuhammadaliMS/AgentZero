/**
 * Outcome Tick — Background outcome executor cron.
 *
 * Advances all executing outcomes for each org.
 * Called every 5 minutes via cron-job.org.
 * Zero LLM cost — executes pre-planned tool calls mechanically.
 */

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tickOutcomes } from '@/lib/agent/planner/background-executor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  // Auth: CRON_SECRET
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const { data: orgs } = await supabase.from('organizations').select('id')

  if (!orgs) {
    return NextResponse.json({ error: 'Failed to fetch organizations' }, { status: 500 })
  }

  const results = []
  for (const org of orgs) {
    try {
      const tick = await tickOutcomes(org.id)
      results.push({ orgId: org.id, ...tick })
    } catch (err) {
      console.error(`[OutcomeTick] Error for org ${org.id}:`, err)
      results.push({ orgId: org.id, error: String(err) })
    }
  }

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    results
  })
}
