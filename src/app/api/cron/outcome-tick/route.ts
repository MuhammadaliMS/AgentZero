/**
 * Outcome Tick — Background outcome executor cron.
 *
 * Advances all executing outcomes for each org.
 * Called every 5 minutes via cron-job.org.
 *
 * Two execution modes per tick:
 * 1. Mechanical: pre-planned tool_call steps (zero LLM cost)
 * 2. Headless Captain: planning outcomes + llm_reasoning steps (LLM cost)
 */

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tickOutcomes } from '@/lib/agent/planner/background-executor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120 // Bumped from 60 — headless captain runs take longer

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

  // LLM key check — headless captain needs an LLM key to plan/reason.
  // Mechanical tool_call execution still works without one.
  const hasLLMKey = !!(process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)
  if (!hasLLMKey) {
    console.log('[OutcomeTick] No LLM key configured — mechanical execution only (no headless planning/reasoning)')
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
