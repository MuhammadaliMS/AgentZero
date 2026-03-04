/**
 * Plan Validator — Deterministic validation for outcome plans.
 *
 * Enforces hard constraints:
 * 1. Max 8 steps per plan
 * 2. All tool names must be in the allowed set
 * 3. No dependency cycles (topological sort)
 * 4. External/destructive tools must have action_type: 'wait_approval'
 * 5. No nesting (create_outcome cannot be a step tool)
 *
 * Zero LLM cost — pure deterministic checks.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface RawPlanStep {
  step_order: number
  description: string
  action_type: 'tool_call' | 'llm_reasoning' | 'wait_input' | 'wait_approval'
  tool_name: string | null
  tool_args: Record<string, unknown> | null
  depends_on_step_orders: number[]
  expected_output: string | null
  one_clear_ask: string | null
}

export interface RawPlan {
  plan_summary: string
  steps: RawPlanStep[]
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
  /** Sanitized plan — only set if valid */
  plan?: RawPlan
}

// ─── Constants ────────────────────────────────────────────────────────────

const MAX_STEPS = 8

/** External/destructive tools that MUST have action_type: 'wait_approval' */
const EXTERNAL_TOOLS = [
  'send_email',
  'send_slack_dm',
  'post_to_channel',
  'send_approval_message',
  'update_slack_message',
  'reply_to_email',
  'forward_email',
  'draft_email',
  'create_commitment',
  'update_commitment',
  'create_action',
  'update_action',
]

/** Tools that CANNOT be used as step tools */
const FORBIDDEN_STEP_TOOLS = [
  'create_outcome',
  'update_outcome',
  'list_outcomes',
]

// ─── Validator ────────────────────────────────────────────────────────────

export function validatePlan(
  plan: RawPlan,
  availableTools: string[]
): ValidationResult {
  const errors: string[] = []

  // 0. Basic shape
  if (!plan || !plan.steps || !Array.isArray(plan.steps)) {
    return { valid: false, errors: ['Plan must have a steps array'] }
  }

  if (!plan.plan_summary || typeof plan.plan_summary !== 'string') {
    errors.push('Plan must have a plan_summary string')
  }

  // 1. Max 8 steps
  if (plan.steps.length > MAX_STEPS) {
    errors.push(`Max ${MAX_STEPS} steps allowed, got ${plan.steps.length}`)
  }

  if (plan.steps.length === 0) {
    errors.push('Plan must have at least 1 step')
  }

  // 2. Valid tool names
  for (const step of plan.steps) {
    if (step.tool_name) {
      if (!availableTools.includes(step.tool_name)) {
        errors.push(`Step ${step.step_order}: unknown tool "${step.tool_name}"`)
      }
    }

    // tool_call must have a tool_name
    if (step.action_type === 'tool_call' && !step.tool_name) {
      errors.push(`Step ${step.step_order}: tool_call action requires tool_name`)
    }
  }

  // 3. No cycles (topological sort check)
  if (hasCycle(plan.steps)) {
    errors.push('Dependency cycle detected in step ordering')
  }

  // 4. External actions require approval
  for (const step of plan.steps) {
    if (
      step.tool_name &&
      EXTERNAL_TOOLS.includes(step.tool_name) &&
      step.action_type !== 'wait_approval'
    ) {
      errors.push(
        `Step ${step.step_order}: external tool "${step.tool_name}" must have action_type "wait_approval"`
      )
    }
  }

  // 5. No nesting — create_outcome cannot be a step tool
  for (const step of plan.steps) {
    if (step.tool_name && FORBIDDEN_STEP_TOOLS.includes(step.tool_name)) {
      errors.push(
        `Step ${step.step_order}: "${step.tool_name}" cannot be used as a step tool (no nested outcomes)`
      )
    }
  }

  // 6. Validate step_order uniqueness
  const orders = plan.steps.map(s => s.step_order)
  const uniqueOrders = new Set(orders)
  if (uniqueOrders.size !== orders.length) {
    errors.push('Duplicate step_order values detected')
  }

  // 7. Dependencies reference existing step_orders
  for (const step of plan.steps) {
    if (step.depends_on_step_orders) {
      for (const dep of step.depends_on_step_orders) {
        if (!uniqueOrders.has(dep)) {
          errors.push(
            `Step ${step.step_order}: depends on non-existent step_order ${dep}`
          )
        }
        if (dep >= step.step_order) {
          errors.push(
            `Step ${step.step_order}: cannot depend on step_order ${dep} (must depend on earlier steps)`
          )
        }
      }
    }
  }

  // 8. wait_input must have one_clear_ask
  for (const step of plan.steps) {
    if (step.action_type === 'wait_input' && !step.one_clear_ask) {
      errors.push(
        `Step ${step.step_order}: wait_input action requires one_clear_ask`
      )
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    plan: errors.length === 0 ? plan : undefined,
  }
}

// ─── Cycle Detection ──────────────────────────────────────────────────────

function hasCycle(steps: RawPlanStep[]): boolean {
  const graph = new Map<number, number[]>()
  const allOrders = new Set<number>()

  for (const step of steps) {
    allOrders.add(step.step_order)
    graph.set(step.step_order, step.depends_on_step_orders ?? [])
  }

  // Kahn's algorithm for topological sort
  const inDegree = new Map<number, number>()
  for (const order of allOrders) {
    inDegree.set(order, 0)
  }

  for (const [, deps] of graph) {
    for (const dep of deps) {
      if (allOrders.has(dep)) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1)
      }
    }
  }

  // Wait — in a DAG with depends_on, the edges go FROM dependency TO dependent.
  // So if step 2 depends_on [1], the edge is 1 → 2.
  // In-degree of 2 is 1 (from step 1).
  // Let me recalculate:
  const inDeg = new Map<number, number>()
  for (const order of allOrders) {
    inDeg.set(order, 0)
  }
  for (const step of steps) {
    // step depends on its deps → each dep has an edge TO this step
    inDeg.set(step.step_order, (step.depends_on_step_orders ?? []).filter(d => allOrders.has(d)).length)
  }

  const queue: number[] = []
  for (const [order, deg] of inDeg) {
    if (deg === 0) queue.push(order)
  }

  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift()!
    visited++

    // Find all steps that depend on current
    for (const step of steps) {
      if ((step.depends_on_step_orders ?? []).includes(current)) {
        const newDeg = (inDeg.get(step.step_order) ?? 1) - 1
        inDeg.set(step.step_order, newDeg)
        if (newDeg === 0) queue.push(step.step_order)
      }
    }
  }

  return visited !== allOrders.size
}

/**
 * Get the list of available tool names for plan validation.
 * These are all the tools the agent can call.
 */
export function getAvailableToolNames(): string[] {
  return [
    // Memory tools
    'recall_memory', 'store_memory', 'query_entity_graph', 'get_entity_timeline',
    // Supabase tools
    'query_commitments', 'query_actions', 'create_commitment', 'update_commitment',
    'create_action', 'update_action',
    // Email tools
    'read_recent_emails', 'search_emails', 'read_email', 'send_email',
    'reply_to_email', 'forward_email', 'draft_email',
    // Slack tools
    'send_slack_dm', 'post_to_channel', 'list_slack_channels',
    'read_slack_channel', 'send_approval_message', 'update_slack_message',
    // Calendar tools
    'get_today_events', 'get_week_events', 'find_free_slots',
    // Vanta tools
    'get_compliance_overview', 'list_failing_controls', 'get_audit_status',
    // Integration tools
    'list_connected_integrations', 'get_integration_health',
    // Decision card
    'emit_decision_card',
    // Special action types (not real tools but valid for plan steps)
    'llm_reasoning', 'wait_input', 'wait_approval',
  ]
}
