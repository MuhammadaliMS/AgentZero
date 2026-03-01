import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getApprovalForAuth, resolveApproval } from '@/lib/agent/approval-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/agent/approve
 *
 * Resolves a pending tool approval request.
 * Called by the client when the user clicks Approve or Reject on an inline
 * approval card in the chat. Updates the pending_approvals DB row, which
 * the SSE stream's poller detects and uses to unblock canUseTool.
 *
 * Security:
 * - Requires authenticated user
 * - Verifies the approval belongs to the user's org (prevents IDOR)
 * - Only resolves approvals that are still 'pending' and not expired
 */
export async function POST(request: NextRequest) {
  // ─── Auth ────────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ─── Input Validation ────────────────────────────────────────────────────
  const body = await request.json()
  const { approvalId, decision } = body as {
    approvalId?: string
    decision?: string
  }

  if (!approvalId || typeof approvalId !== 'string') {
    return NextResponse.json({ error: 'approvalId is required' }, { status: 400 })
  }

  if (!decision || !['approve', 'reject'].includes(decision)) {
    return NextResponse.json(
      { error: 'decision must be "approve" or "reject"' },
      { status: 400 }
    )
  }

  // ─── Fetch Approval + Org Ownership Check ────────────────────────────────
  const approval = await getApprovalForAuth(approvalId)

  if (!approval) {
    return NextResponse.json(
      { error: 'Approval not found or already resolved' },
      { status: 404 }
    )
  }

  if (approval.status !== 'pending' || new Date(approval.expires_at) < new Date()) {
    return NextResponse.json(
      { error: 'Approval not found or already resolved' },
      { status: 404 }
    )
  }

  // Verify the user belongs to the same org as the approval
  const admin = createAdminClient()
  const { data: profile } = await admin
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()

  if (!profile?.org_id || profile.org_id !== approval.org_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Resolve ─────────────────────────────────────────────────────────────
  const resolved = await resolveApproval(approvalId, decision as 'approve' | 'reject')

  if (!resolved) {
    return NextResponse.json(
      { error: 'Failed to resolve approval — it may have already expired' },
      { status: 409 }
    )
  }

  console.log(
    `[Approve API] Approval ${approvalId} resolved: ${decision} by user ${user.id}`
  )

  return NextResponse.json({ success: true, approvalId, decision })
}
