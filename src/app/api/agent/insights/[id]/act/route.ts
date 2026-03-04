import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Json, Database } from '@/types/database'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/agent/insights/[id]/act
 *
 * Manually trigger an action from an insight.
 * Creates a patrol_finding and insight_action record.
 *
 * Body: { action?: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: insightId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  const admin = createAdminClient()

  // Verify the insight belongs to this org and is actionable
  const { data: insight } = await admin
    .from('graph_insights')
    .select('id, org_id, insight_type, summary, confidence, related_entity_ids, action_template, status')
    .eq('id', insightId)
    .eq('org_id', profile.org_id)
    .single()

  if (!insight) {
    return NextResponse.json({ error: 'Insight not found' }, { status: 404 })
  }

  if (insight.status === 'routed') {
    return NextResponse.json({ error: 'Insight already routed' }, { status: 409 })
  }

  const body = await request.json().catch(() => ({}))

  // Map insight type to finding type (same logic as insight-action-router)
  const findingTypeMap: Record<string, string> = {
    contradiction: 'unresolved_blocker',
    risk: 'at_risk_commitment',
    anomaly: 'anomaly_detected',
    stale: 'stale_entity',
    pattern: 'recurring_pattern',
    opportunity: 'opportunity_identified',
    correlation: 'recurring_pattern',
    compression: 'recurring_pattern',
  }
  const findingType = findingTypeMap[insight.insight_type] ?? 'stale_entity'

  // Create patrol finding
  const { data: finding, error: findingError } = await admin
    .from('patrol_findings')
    .insert({
      org_id: profile.org_id,
      type: findingType as Database['public']['Tables']['patrol_findings']['Insert']['type'],
      title: insight.summary.slice(0, 200),
      description: `[💡 Manual action] ${insight.summary}\n\nTriggered by user from insights dashboard.${body.action ? `\n\nAction: ${body.action}` : ''}`,
      severity: insight.confidence >= 0.8 ? 'high' : 'medium',
      status: 'open' as const,
      entity_id: insight.related_entity_ids?.[0] ?? null,
      metadata: {
        source: 'graph_insight',
        insight_id: insight.id,
        insight_type: insight.insight_type,
        decision_mode: 'recommended',
        triggered_by: user.id,
      } as unknown as Json,
    })
    .select('id')
    .single()

  if (!finding) {
    return NextResponse.json({ error: 'Failed to create finding' }, { status: 500 })
  }

  // Record in insight_actions
  const { error: actionError } = await admin.from('insight_actions').insert({
    org_id: profile.org_id,
    insight_id: insightId,
    finding_id: finding.id,
    action_id: null,
    decision_mode: 'recommended',
    policy_path: `manual.${insight.insight_type}`,
    execution_result: 'pending',
  })

  if (actionError) {
    console.error('[InsightAct] Failed to create insight_action:', actionError)
  }

  // Update insight status
  await admin
    .from('graph_insights')
    .update({
      routed_finding_id: finding.id,
      status: 'routed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', insightId)

  return NextResponse.json({ ok: true, findingId: finding.id })
}
