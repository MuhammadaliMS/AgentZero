// ─── Approval Store (Supabase-backed) ────────────────────────────────────────
// DB-backed approval store that works across serverless function invocations.
//
// Problem with in-memory Maps on Vercel:
// The SSE stream handler (container A) creates an approval and awaits a Promise.
// The /api/agent/approve handler (container B) tries to resolve it — but container B
// has a fresh process with an empty Map, so the resolve is a no-op.
//
// Solution: persist approval state in Supabase `pending_approvals` table.
// The SSE stream handler polls the row every 300ms for a status change.
// The approve handler updates the row status, which the poller detects.
//
// Flow:
// 1. canUseTool calls createApprovalRequest → inserts row, starts polling
// 2. SSE emits 'approval_required' event to client
// 3. User clicks Approve/Reject in chat UI
// 4. Client POSTs to /api/agent/approve
// 5. approve endpoint updates DB row status
// 6. Poller detects status change → resolves Promise
// 7. canUseTool returns allow/deny to SDK

import { randomUUID } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/database'

const APPROVAL_TIMEOUT_MS = 120_000 // 2 minutes
const POLL_INTERVAL_MS = 300        // Poll DB every 300ms

/**
 * Create a new approval request that blocks until resolved.
 * Inserts a pending_approvals row and polls for status changes.
 * Returns approvalId and a Promise that resolves with the user's decision.
 */
export async function createApprovalRequest(
  toolName: string,
  toolInput: Record<string, unknown>,
  conversationId: string,
  orgId: string
): Promise<{ approvalId: string; promise: Promise<'approve' | 'reject'> }> {
  const approvalId = randomUUID()
  const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString()

  // Single admin client reused across insert, polling, and timeout cleanup.
  // Avoids creating a new Supabase client every 300ms poll tick.
  const admin = createAdminClient()

  // Insert the approval record into DB
  const { error: insertError } = await admin.from('pending_approvals').insert({
    approval_id: approvalId,
    conversation_id: conversationId,
    org_id: orgId,
    tool_name: toolName,
    tool_input: toolInput as unknown as Json,
    status: 'pending',
    expires_at: expiresAt,
  })

  if (insertError) {
    // Log failure — the poller would eventually timeout to 'reject' anyway,
    // but logging makes the root cause visible in server logs.
    console.error(`[ApprovalStore] Failed to insert approval ${approvalId}:`, insertError.message)
  }

  // Poll DB for resolution — runs inside the long-lived SSE stream function.
  // Reuses the same admin client to avoid creating a new one every 300ms.
  const promise = new Promise<'approve' | 'reject'>((resolve) => {
    let settled = false

    const poll = async () => {
      if (settled) return
      try {
        const { data } = await admin
          .from('pending_approvals')
          .select('status')
          .eq('approval_id', approvalId)
          .single()

        if (data?.status === 'approved') {
          settled = true
          clearInterval(intervalId)
          resolve('approve')
        } else if (data?.status === 'rejected') {
          settled = true
          clearInterval(intervalId)
          resolve('reject')
        }
      } catch {
        // Transient DB error — continue polling
      }
    }

    const intervalId = setInterval(poll, POLL_INTERVAL_MS)

    // Auto-reject on timeout — clears interval and marks expired in DB
    setTimeout(async () => {
      if (!settled) {
        settled = true
        clearInterval(intervalId)
        resolve('reject')
        // Mark as rejected in DB so the approve endpoint knows it's expired
        await admin
          .from('pending_approvals')
          .update({ status: 'rejected', resolved_at: new Date().toISOString() })
          .eq('approval_id', approvalId)
          .eq('status', 'pending')
      }
    }, APPROVAL_TIMEOUT_MS)
  })

  return { approvalId, promise }
}

/**
 * Resolve a pending approval with the user's decision.
 * Updates the DB row — the SSE poller will detect the change.
 * Returns true if the approval was found and updated, false otherwise.
 */
export async function resolveApproval(
  approvalId: string,
  decision: 'approve' | 'reject'
): Promise<boolean> {
  const admin = createAdminClient()
  const status = decision === 'approve' ? 'approved' : 'rejected'

  // Use .select() to get back matched rows — if empty, the approval was
  // already resolved or doesn't exist. Supabase's .update() returns
  // error: null even when 0 rows match, so we can't rely on !error alone.
  const { data, error } = await admin
    .from('pending_approvals')
    .update({ status, resolved_at: new Date().toISOString() })
    .eq('approval_id', approvalId)
    .eq('status', 'pending') // Only resolve if still pending (idempotent guard)
    .select('approval_id')

  if (error) return false

  // data is an array — if empty, no rows matched (already resolved/expired)
  return Array.isArray(data) && data.length > 0
}

/**
 * Get the current status of an approval, with org ownership info.
 * Used by the approve endpoint to verify ownership before resolving.
 */
export async function getApprovalForAuth(approvalId: string): Promise<{
  org_id: string
  status: string
  expires_at: string
} | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('pending_approvals')
    .select('org_id, status, expires_at')
    .eq('approval_id', approvalId)
    .single()

  return data ?? null
}

/**
 * Cleanup all pending approvals for a conversation (fire-and-forget).
 * Called when the SSE connection is closed (user disconnects).
 * Updates the DB so no lingering 'pending' rows remain.
 */
export async function cleanupConversationApprovals(conversationId: string): Promise<void> {
  const admin = createAdminClient()
  await admin
    .from('pending_approvals')
    .update({ status: 'rejected', resolved_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
}

/**
 * Get count of currently pending approvals (for monitoring).
 */
export async function getPendingApprovalCount(): Promise<number> {
  const admin = createAdminClient()
  const { count } = await admin
    .from('pending_approvals')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())

  return count ?? 0
}
