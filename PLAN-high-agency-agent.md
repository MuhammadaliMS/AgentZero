# Chief-of-Staff High-Agency Agent — Complete Implementation Plan

## Current State Assessment

The infrastructure is strong. What's missing is the **wiring** that turns observation into action.

### What's LIVE and working:
- ✅ 33 agent tools (email, Slack, calendar, Vanta, memory, commitments, actions)
- ✅ Outcome runtime CRUD (`outcome-runtime.ts` — createOutcome, createRun, addSteps, updateStep, getNextExecutableSteps)
- ✅ Schema for outcomes/runs/steps (migration 010)
- ✅ Progressive rollout system (shadow → assisted → auto) with PreToolUse gating
- ✅ Approval store (DB-backed polling for serverless)
- ✅ Patrol scanner + nudge engine (background intelligence → findings → Slack DMs)
- ✅ Associative recall + contradiction engine + ghost agent (high-agency memory v3)
- ✅ Decision cards (structured reasoning audit trail)
- ✅ 22 stream event types defined
- ✅ Feedback loop (nudge acknowledged → signal weight adjustment)

### What's NOT wired (the gap):
- ❌ **Outcome tools not registered** — `create_outcome`, `update_outcome`, `list_outcomes` don't exist in either SDK path (33 tools total, zero outcome tools)
- ❌ **Dual SDK path mismatch risk** — `sdk-switch.ts` dispatches between Claude (default) and OpenAI paths. Claude uses `createSdkMcpServer()` in `orchestrator.ts`, OpenAI uses `tool()` wrappers in `captain-tools.ts`. New tools must be registered in BOTH or the default Claude path misses them
- ❌ **No background executor** — outcomes only progress during chat turns. Without an async outcome tick, the agent is high-assist, not chief-of-staff. `getNextExecutableSteps()` exists but nothing calls it between conversations
- ❌ **No planner** — outcome runtime has CRUD but no LLM generates plans
- ❌ **Default rollout is shadow mode** — agent can only think, not act
- ❌ **No cold start bootstrap** — zero interactions = can never earn trust to advance
- ❌ **No adjudication** — agent doesn't decide when a user message needs a multi-step plan vs. a simple response
- ❌ **`pending_approvals` CREATE TABLE missing** — referenced in FK but never created
- ❌ **No step timeout/failure recovery** — steps can hang forever
- ❌ **No replan trigger** — outcome can fail but nobody creates run v2

### Diagnosis:
The system is a **9/10 observation engine** with a **2/10 execution engine**. The CRUD exists, the schema exists, the rollout gating works — but the agent has no tools to create outcomes, no brain to plan/execute them, and no background worker to keep progress moving between conversations.

---

## Architecture Principle: Implicit Adjudication

**The agent decides naturally.** No separate `adjudicateGoal()` LLM call per message.

Instead:
1. The prompt tells Captain: "If a user request requires 2+ steps, call `create_outcome` to track it"
2. The agent naturally calls `create_outcome` (or doesn't) based on task complexity
3. If it creates an outcome, the planner generates a constrained plan
4. If it doesn't, it's a simple response — no overhead

**Cost: $0 extra per simple message.** Only multi-step tasks pay for planning.

---

## Phase 0: Foundation Fixes (1–2 days)

Things that should already work but don't.

### 0a. Create `pending_approvals` table

**File: `supabase/migrations/011_pending_approvals.sql`** (new)

The approval-store.ts already uses this table. Migration 010 references it as FK. But no CREATE TABLE exists.

```sql
CREATE TABLE IF NOT EXISTS pending_approvals (
  approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_input JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '2 minutes'
);

CREATE INDEX idx_pa_conversation ON pending_approvals(conversation_id) WHERE status = 'pending';
CREATE INDEX idx_pa_expires ON pending_approvals(expires_at) WHERE status = 'pending';

ALTER TABLE pending_approvals ENABLE ROW LEVEL SECURITY;

-- Service role only (internal system use)
CREATE POLICY "service_role_all" ON pending_approvals
  FOR ALL USING (true) WITH CHECK (true);
```

### 0b. Cold start bootstrap

**File: `src/lib/agent/runtime/rollout-manager.ts`** (modify)

Problem: New orgs start in shadow mode. Shadow mode blocks all tools except memory. With zero interactions, the agent can never earn trust to advance to assisted mode.

Fix: **Start new orgs in `assisted` mode** instead of `shadow`.

```typescript
// In getRolloutConfig(), change the default:
rollout_mode: 'assisted',  // was: 'shadow'
```

Rationale: Assisted mode already requires approval for medium/high-risk tools. It's the right starting point — the agent can read and act, but external actions need the user's click. Shadow mode was over-cautious for a tool the user just set up.

Also: **Lower `min_interactions` from 40 to 20** for first advancement (assisted → auto). 40 is ~2 weeks of daily use before the agent can auto-execute anything. 20 is ~1 week, which is enough signal.

### 0c. Fix outcome_steps FK to pending_approvals

**File: `supabase/migrations/011_pending_approvals.sql`** (same file)

Migration 010 line 149 references `pending_approvals(approval_id)` but the table didn't exist. Now it does. If migration 010 was applied without the table, the FK would have failed. Add a safety re-add:

```sql
-- Re-add FK if migration 010 failed this constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'outcome_steps_approval_id_fkey'
  ) THEN
    ALTER TABLE outcome_steps
      ADD CONSTRAINT outcome_steps_approval_id_fkey
      FOREIGN KEY (approval_id) REFERENCES pending_approvals(approval_id)
      ON DELETE SET NULL;
  END IF;
END $$;
```

---

## Phase 1: Execution Engine (2–3 weeks)

The core loop: user speaks → agent decides → plan created → steps execute → outcome tracked.

### 1a. Register Outcome Tools (3 tools) — Dual SDK Registration

**CRITICAL: Two SDK paths exist.** `sdk-switch.ts` dispatches between Claude (default) and OpenAI. Tools must be registered in BOTH or the default path misses them.

**Architecture:**
```
src/lib/agent/tools/outcome-tools.ts     ← Shared tool LOGIC (new)
        │
        ├──→ orchestrator.ts buildMcpServers()   ← Claude SDK path (createSdkMcpServer)
        │     └─ context-builder.ts getRequiredToolSets() adds 'outcome'
        │
        └──→ captain-tools.ts createCaptainTools()  ← OpenAI SDK path (tool() wrappers)
```

This follows the exact pattern used by all 7 existing tool sets (supabase, memory, integration, slack, email, calendar, vanta).

**File: `src/lib/agent/tools/outcome-tools.ts`** (new)

Exports `createOutcomeTools(orgId, conversationId)` — returns tool definitions compatible with `createSdkMcpServer()`. Three tools:

#### `create_outcome`
```typescript
// Input: { title, description?, priority?, steps?: Array<{ description, tool_name?, tool_args?, depends_on_step_order? }> }
// What it does:
// 1. Insert outcome row (status: 'planning')
// 2. If steps provided: call planOutcome() to validate + create run + steps
// 3. If no steps: create empty run, agent will add steps later or handle inline
// 4. Emit 'outcome_started' stream event
// 5. Return: { outcomeId, runId, stepCount, status }
```

#### `update_outcome`
```typescript
// Input: { outcome_id, status?, blocker_summary?, step_updates?: Array<{ step_id, status, result_summary? }> }
// What it does:
// 1. Update outcome status if provided
// 2. Update step statuses if provided (with org guard)
// 3. If marking step as 'failed': trigger replan check
// 4. If marking outcome as 'blocked': set blocker_summary with ONE clear ask
// 5. Emit appropriate stream events
// 6. Return: { outcome, run, steps }
```

#### `list_outcomes`
```typescript
// Input: { status_filter?, limit? }
// What it does:
// 1. Get outcomes for org (active/blocked/recent completed)
// 2. For each: include current run + step summary
// 3. Return formatted list with blockers highlighted
```

**Claude SDK registration** (`orchestrator.ts`):
```typescript
// In buildMcpServers(), add to toolSetMap:
outcome: () =>
  createSdkMcpServer({
    name: 'outcome-tools',
    tools: createOutcomeTools(orgId, conversationId),
  }),
```

**Claude SDK tool set list** (`context-builder.ts`):
```typescript
// In getRequiredToolSets(), add 'outcome':
return ['supabase', 'memory', 'integration', 'slack', 'email', 'calendar', 'vanta', 'outcome']
```

**OpenAI SDK registration** (`captain-tools.ts`):
```typescript
// In createCaptainTools(), add OpenAI tool() wrappers that call the same shared logic:
...createOutcomeToolsOpenAI(toolParams),
```

### 1b. Constrained DAG Planner

**File: `src/lib/agent/planner/outcome-planner.ts`** (new)

The planner is an LLM call (same model as Captain) that converts an outcome into a run with steps.

#### `planOutcome(orgId, outcomeId, title, description, existingTools)`

**Input:** Outcome metadata + list of available tool names + existing context (recalled memories, entity graph)

**Prompt template:**
```
You are a task planner. Given a goal, produce a plan as a JSON array of steps.

CONSTRAINTS (HARD — violating these invalidates the plan):
1. Max 8 steps per plan
2. Each step must use one of these tool names: [${toolNames}] or be 'llm_reasoning' (think) / 'wait_input' (ask user)
3. No cycles in depends_on — steps can only depend on earlier step_orders
4. External actions (send_email, send_slack_dm, post_to_channel) MUST have action_type: 'wait_approval'
5. No step can create another outcome (no nesting)
6. If a step needs user input, set action_type: 'wait_input' and set one_clear_ask

OUTPUT FORMAT (strict JSON):
{
  "plan_summary": "one sentence",
  "steps": [
    {
      "step_order": 1,
      "description": "what this step does",
      "action_type": "tool_call" | "llm_reasoning" | "wait_input" | "wait_approval",
      "tool_name": "recall_memory" | null,
      "tool_args": {} | null,
      "depends_on_step_orders": [],
      "expected_output": "what success looks like",
      "one_clear_ask": null | "question for user"
    }
  ]
}

GOAL: ${title}
DESCRIPTION: ${description}
```

**Validation (post-LLM, deterministic):**
```typescript
function validatePlan(plan: RawPlan, availableTools: string[]): ValidationResult {
  const errors: string[] = []

  // 1. Max 8 steps
  if (plan.steps.length > 8) errors.push('Max 8 steps')

  // 2. Valid tool names
  for (const step of plan.steps) {
    if (step.tool_name && !availableTools.includes(step.tool_name))
      errors.push(`Unknown tool: ${step.tool_name}`)
  }

  // 3. No cycles (topological sort check)
  if (hasCycle(plan.steps)) errors.push('Dependency cycle detected')

  // 4. External actions require approval
  const EXTERNAL_TOOLS = ['send_email', 'send_slack_dm', 'post_to_channel', 'send_approval_message', 'update_slack_message']
  for (const step of plan.steps) {
    if (step.tool_name && EXTERNAL_TOOLS.includes(step.tool_name) && step.action_type !== 'wait_approval')
      errors.push(`${step.tool_name} must be wait_approval`)
  }

  // 5. No nesting
  for (const step of plan.steps) {
    if (step.tool_name === 'create_outcome') errors.push('Cannot nest outcomes')
  }

  return { valid: errors.length === 0, errors }
}
```

**On validation failure:** Log error, store outcome as failed with error message. Don't retry (user can re-request). One LLM call max.

**Cost:** ~$0.01–0.03 per plan (one LLM call with structured output).

### 1c. Step Executor (dual-mode: in-conversation + background)

**File: `src/lib/agent/planner/step-executor.ts`** (new)

The executor has **two calling modes** with the same core logic:

1. **In-conversation** — called by the agent during a chat turn (via `create_outcome` or `update_outcome` tools). Results are incorporated into the agent's response.
2. **Background** — called by the outcome-tick cron (Phase 1h). Results are stored in DB and user is notified via Slack nudge.

```typescript
/**
 * Execute the next ready steps for an outcome.
 *
 * @param mode - 'conversation' (agent is present, can handle llm_reasoning steps)
 *             | 'background' (cron context, skips llm_reasoning and wait_input steps)
 * @param toolExecutor - function that executes a tool by name. In conversation mode,
 *                        this wraps the agent's tool calls. In background mode, this
 *                        calls the shared tool functions directly (no LLM involved).
 */
export async function executeNextSteps(
  orgId: string,
  outcomeId: string,
  runId: string,
  toolExecutor: (toolName: string, toolArgs: Record<string, unknown>) => Promise<string>,
  opts?: { maxSteps?: number; timeoutMs?: number; mode?: 'conversation' | 'background' }
): Promise<StepExecutionResult[]>
```

**Per-step execution:**
1. Get next executable steps (dependencies met, status=pending)
2. For each (up to `maxSteps`, default 3):
   a. Update step status → 'executing'
   b. If `action_type === 'wait_input'` or `'wait_approval'`: mark as 'blocked', set blocker_type, skip
   c. If `action_type === 'llm_reasoning'`:
      - In `conversation` mode: return step for agent to handle inline
      - In `background` mode: **skip** (stays pending — deferred to next chat turn)
   d. If `action_type === 'tool_call'`: call `toolExecutor(step.tool_name, step.tool_args)` with 30s timeout
   e. On success: update step → 'completed' with result_summary
   f. On failure: update step → 'failed' with error_message
   g. On timeout: update step → 'failed' with error "Tool execution timed out after 30s"

**Step timeout:** 30s hard limit per tool call. Implemented via `Promise.race([toolCall, timeoutPromise])`.

**Max retries:** 0 per step. If a step fails, it stays failed. The agent can trigger a replan (new run) if needed.

**After all steps execute:**
- If all steps completed → update outcome status → 'completed'
- If any step failed → update outcome status → 'failed', set blocker_summary
- If any step blocked (needs input/approval) → update outcome status → 'blocked', set blocker_summary to the step's `one_clear_ask`
- If some completed but remaining pending → outcome stays 'executing'

### 1h. Background Outcome Executor (cron)

**This is what makes it a chief-of-staff, not a chatbot.** Outcomes progress between conversations.

**File: `src/lib/agent/planner/background-executor.ts`** (new)

```typescript
/**
 * Background outcome tick — advances all executing outcomes for an org.
 * Called by cron every 5 minutes. Zero LLM cost — the planner already
 * decomposed tasks into tool calls with specific args.
 *
 * What it CAN execute (no LLM needed):
 * - tool_call steps: call the tool function directly with pre-planned args
 * - wait_dependency steps: check if dependency is now met, advance if so
 *
 * What it CANNOT execute (needs conversation context):
 * - llm_reasoning steps: skip, leave pending for next chat turn
 * - wait_input steps: skip, send nudge if not already sent
 * - wait_approval steps: skip, send nudge if not already sent
 */
export async function tickOutcomes(orgId: string): Promise<TickResult> {
  const supabase = createAdminClient()

  // 1. Get all outcomes in 'executing' status for this org
  const { data: outcomes } = await supabase
    .from('outcomes')
    .select('id')
    .eq('org_id', orgId)
    .eq('status', 'executing')

  if (!outcomes?.length) return { processed: 0, stepsExecuted: 0, stepsBlocked: 0 }

  let stepsExecuted = 0
  let stepsBlocked = 0

  for (const outcome of outcomes) {
    // 2. Get active run
    const plan = await getOutcomeWithPlan(outcome.id, orgId)
    if (!plan?.run || plan.run.status !== 'active') continue

    // 3. Get next executable steps
    const readySteps = await getNextExecutableSteps(plan.run.id)

    for (const step of readySteps) {
      // 4. Skip steps that need conversation context
      if (['llm_reasoning', 'wait_input', 'wait_approval'].includes(step.actionType)) {
        // Send nudge if blocked and no recent nudge sent
        if (step.actionType !== 'llm_reasoning' && step.oneClearAsk) {
          await maybeNudgeForBlockedStep(orgId, outcome.id, step)
        }
        stepsBlocked++
        continue
      }

      // 5. Execute tool_call steps directly
      if (step.actionType === 'tool_call' && step.toolName && step.toolArgs) {
        const result = await executeToolDirectly(
          orgId, step.toolName, step.toolArgs, { timeoutMs: 30_000 }
        )
        await updateStep(step.id, {
          status: result.success ? 'completed' : 'failed',
          resultSummary: result.summary,
          errorMessage: result.error ?? null,
        }, orgId)
        stepsExecuted++
      }
    }

    // 6. Check if outcome is now complete/failed
    await reconcileOutcomeStatus(orgId, outcome.id, plan.run.id)
  }

  return { processed: outcomes.length, stepsExecuted, stepsBlocked }
}
```

**`executeToolDirectly()` — headless tool execution:**

```typescript
/**
 * Execute a tool function directly without an LLM agent.
 * Uses the same shared tool logic from src/lib/agent/tools/.
 * No conversation context, no streaming, no approval gate.
 *
 * SAFETY: Only tool_call steps with pre-validated tool names reach here.
 * External tools (send_email, etc.) were already forced to wait_approval
 * by the plan validator — they never reach background execution.
 */
async function executeToolDirectly(
  orgId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  opts: { timeoutMs: number }
): Promise<{ success: boolean; summary: string; error?: string }>
```

This function maps tool names to the shared tool implementations in `src/lib/agent/tools/`:
- `recall_memory` → calls `createMemoryTools()` logic
- `query_commitments` → calls `createSupabaseTools()` logic
- `get_compliance_overview` → calls `createVantaTools()` logic
- etc.

**SAFETY INVARIANT:** The plan validator (Phase 1b) already enforced that all external/destructive tools (`send_email`, `send_slack_dm`, `post_to_channel`) have `action_type: 'wait_approval'`. The background executor never sees these — they're already blocked waiting for user approval. Only read-only and internal-write tools execute in background.

**File: `src/app/api/cron/outcome-tick/route.ts`** (new)

```typescript
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Most ticks are fast (SQL + tool calls)

export async function GET(request: Request) {
  // Auth: CRON_SECRET
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
  if (request.headers.get('authorization') !== `Bearer ${cronSecret}`)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createAdminClient()
  const { data: orgs } = await supabase.from('organizations').select('id')
  if (!orgs) return NextResponse.json({ error: 'Failed to fetch orgs' }, { status: 500 })

  const results = []
  for (const org of orgs) {
    try {
      const tick = await tickOutcomes(org.id)
      results.push({ orgId: org.id, ...tick })
    } catch (err) {
      console.error(`[OutcomeTick] Error for org ${org.id}:`, err)
      results.push({ orgId: org.id, error: true })
    }
  }

  return NextResponse.json({ results })
}
```

**cron-job.org:** Add 9th job — `POST /api/cron/outcome-tick` every 5 minutes.

**`maybeNudgeForBlockedStep()` — user notification:**

When a step is blocked (needs input or approval) and the user hasn't been nudged recently:
1. Check `nudges` table for recent nudge about this outcome (within 4 hours)
2. If no recent nudge: create a patrol_finding with the step's `one_clear_ask`
3. Nudge engine picks it up on next run and sends Slack DM
4. Example: "📋 Your board report is 3/5 steps done but blocked — I need to know: Who should be CC'd on the email?"

**`reconcileOutcomeStatus()` — post-tick status sync:**

After executing steps, check the overall outcome state:
- All steps completed → outcome 'completed', notify user via Slack
- Any step failed → outcome 'failed', notify user
- Steps still pending but none executable (all blocked on dependencies/input) → outcome 'blocked'
- Steps still pending with some executable → outcome stays 'executing' (next tick will continue)

### 1d. Replan Logic

**File: `src/lib/agent/planner/outcome-planner.ts`** (same file)

#### `replanOutcome(orgId, outcomeId, reason)`

Triggered when:
- A step fails and agent calls `update_outcome` with a replan request
- User provides new information that changes the plan

**Rules:**
1. **Latest run wins**: Previous active run → `status = 'superseded'`. All its pending/blocked steps → `status = 'skipped'`
2. **Max 3 replans per outcome**: If `plan_version > 3`, mark outcome as 'failed' with "Exceeded maximum replan attempts"
3. **Completed steps carry forward**: The new plan's prompt includes results from completed steps so the planner doesn't redo work
4. **Same constraints apply**: Max 8 steps, valid tools, no cycles, external needs approval

**Prompt addition for replan:**
```
PREVIOUS PLAN RESULTS (steps already completed — do not repeat):
${completedSteps.map(s => `- Step ${s.step_order}: ${s.description} → ${s.resultSummary}`).join('\n')}

FAILURE REASON: ${reason}

Create a NEW plan that accounts for the completed work and the failure.
```

### 1e. Prompt Update for Implicit Adjudication

**File: `src/lib/agent/prompts/captain.ts`** (modify)

Add to `CAPTAIN_BASE_PROMPT` after "## Outcome-Driven Work":

```markdown
## When to Create Outcomes
- **Simple questions** (What's on my calendar? Check my email) → just use tools directly, no outcome needed
- **Multi-step tasks** (Prepare a board report, do a SOC2 audit review, prep for my meeting with Sarah) → call `create_outcome` with a title and steps
- **Rule of thumb**: If you need 2+ tool calls that depend on each other's results, create an outcome

## Outcome Execution
- When you create an outcome, the system validates your plan and stores steps
- Execute steps by calling the tools yourself in order — the outcome tracks your progress
- If a step gets **blocked** (needs user input or approval), tell the user the ONE question that will unblock it
- If a step **fails**, you can update the outcome to trigger a replan — but max 3 replans per outcome
- When all steps are done, mark the outcome as completed
- Active outcomes carry across conversations — check `list_outcomes` at conversation start

## Background Execution
- Outcomes with `tool_call` steps continue executing **between conversations** via a background worker
- If the user closes the chat, tool_call steps (data gathering, lookups, queries) keep running
- Steps that need your reasoning (`llm_reasoning`) wait for the next conversation — the background worker skips them
- Steps that need user input or approval send a Slack nudge and wait
- When an outcome completes in the background, the user gets a Slack notification
- **Tell the user this**: "I'll keep working on this in the background — you'll get a Slack notification when it's done or if I need your input"

## Reporting Outcomes
- When asked "what are you working on?" → call `list_outcomes` to show active tasks
- For blocked outcomes → lead with the blocker and the one unblocking question
- For completed outcomes → summarize what was accomplished
```

### 1f. Wire Outcome Stream Events

**File: `src/lib/agent/orchestrator.ts`** (modify)

The stream events for outcomes are already defined in the type union. Wire them:

In the PostToolUse hook, after tool execution:
```typescript
// After create_outcome tool completes:
if (baseName === 'create_outcome' && result) {
  hookEventQueue.push({
    type: 'outcome_started',
    outcomeId: result.outcomeId,
    outcomeTitle: result.title,
  })
}

// After update_outcome with status change:
if (baseName === 'update_outcome' && result?.statusChanged) {
  const eventType = result.newStatus === 'blocked' ? 'outcome_blocked'
    : ['completed', 'failed', 'cancelled'].includes(result.newStatus) ? 'outcome_completed'
    : null
  if (eventType) {
    hookEventQueue.push({
      type: eventType,
      outcomeId: result.outcomeId,
      outcomeStatus: result.newStatus,
    })
  }
}
```

### 1g. Outcome recall at conversation start

**File: `src/lib/agent/context-builder.ts`** (modify)

Add active outcomes to the context injected at conversation start:

```typescript
// After graph context injection:
const activeOutcomes = await getActiveOutcomes(orgId, 5)
if (activeOutcomes.length > 0) {
  const outcomeSummary = activeOutcomes.map(o => {
    const status = o.status === 'blocked' ? `⛔ BLOCKED: ${o.blockerSummary}` : o.status
    return `- ${o.title} [${status}] (${o.priority})`
  }).join('\n')
  context.systemPrompt += `\n\n## Active Outcomes\n${outcomeSummary}`
}
```

---

## Phase 2: Intelligence Layer (1–2 weeks, after Phase 1 stable)

Connect the background intelligence to the execution engine.

### 2a. Insight-to-Outcome Pipeline

**File: `src/lib/graph/insight-action-router.ts`** (modify existing)

Currently: insights route to `patrol_findings` → nudge engine → Slack DM (passive notification).

Enhancement: High-confidence insights can create **outcomes** directly.

```typescript
// In routeInsightToAction():
if (insight.action_template?.type === 'create_outcome' && decisionMode === 'recommended') {
  // Instead of just creating a patrol_finding, also create an outcome
  const outcomeId = await createOutcome({
    orgId,
    title: insight.action_template.suggested_outcome_title,
    description: insight.summary,
    goalType: 'proactive_signal',
    priority: insight.confidence >= 0.85 ? 'high' : 'medium',
    relatedEntityIds: insight.related_entity_ids,
  })

  // The outcome starts as 'planning' — nudge tells user about it
  // User can approve/modify/dismiss from chat
}
```

**No auto-execution of proactive outcomes.** All proactive outcomes start as 'planning' and require user acknowledgment before steps execute. The nudge says: "I noticed X. I've drafted a plan to handle it. Want me to proceed?"

### 2b. Patrol Finding → Outcome Linking

**File: `src/lib/intelligence/patrol-scanner.ts`** (modify)

When a patrol finding is about a commitment that has an outcome:
```typescript
// In scanDeadlineCommitments():
// Check if commitment is linked to an active outcome
// If so: update the outcome's blocker_summary instead of creating a new finding
// This prevents duplicate signals (outcome tracker + patrol finding for same thing)
```

### 2c. Brief Insights → Outcome Status

**File: `src/lib/intelligence/brief-synthesizer.ts`** (modify)

Add outcome status to morning brief:

```typescript
// In gatherWorkerViews(), add 6th parallel query:
const outcomesView = await gatherOutcomesView(orgId)

// In buildBriefPrompt(), add section:
// ## Active Outcomes
// - "Board report preparation" — executing (3/5 steps done)
// - "SOC2 audit review" — ⛔ BLOCKED: "Need access to Vanta evidence exports"
```

### 2d. Feedback Backflow into Outcomes

**File: `src/lib/intelligence/feedback-tracker.ts`** (modify)

When user acknowledges a nudge that's linked to an outcome:
```typescript
// In trackNudgeAcknowledged():
if (finding.metadata?.outcome_id) {
  // If user accepted: resume outcome (change 'blocked' → 'executing')
  // If user rejected: cancel outcome
  // Track as 'accepted'/'rejected' utility event
}
```

---

## Phase 3: Trust Calibration (ongoing, 1 week initial)

### 3a. Rollout advancement criteria refinement

**File: `src/lib/agent/runtime/rollout-manager.ts`** (modify)

Current criteria (from shadow → assisted → auto) uses automated metrics. Replace with **manual evaluation + automated safety guard**:

**Automated safety guard (always enforced):**
- Error rate > 10% → auto-revert to previous mode
- 3+ consecutive tool failures → pause and notify

**Advancement (assisted → auto):**
- Must have ≥20 interactions (lowered from 40)
- Acceptance rate ≥ 75% (lowered from 80% — at this stage, the approval gate catches bad actions)
- No critical errors in last 7 days
- **Manual gate**: Org admin must explicitly confirm advancement via API endpoint or chat command ("Captain, switch to auto mode")

The manual gate prevents premature advancement. The agent should earn it, and the user should feel in control.

### 3b. Outcome success tracking → rollout measurement

**File: `src/lib/agent/runtime/rollout-manager.ts`** (modify `recordWeeklyMeasurement`)

Add outcome metrics to weekly measurement:
```typescript
// Query outcomes completed/failed this week
const { data: outcomes } = await supabase
  .from('outcomes')
  .select('status')
  .eq('org_id', orgId)
  .gte('updated_at', weekStart)

measurement.total_outcomes = outcomes?.length ?? 0
measurement.completed_outcomes = outcomes?.filter(o => o.status === 'completed').length ?? 0
measurement.failed_outcomes = outcomes?.filter(o => o.status === 'failed').length ?? 0
```

### 3c. Rollout mode command

**File: `src/lib/agent/prompts/captain.ts`** (modify)

Add to prompt:
```markdown
## Rollout Mode
- Current mode is injected in your context
- If user says "switch to auto mode" or "I trust you more" → call the rollout advancement API
- If user says "go back to assisted" or "slow down" → call the rollout revert API
- Never self-promote — always require explicit user command
```

**File: `src/app/api/agent/rollout/route.ts`** (already exists — POST handler is the advancement trigger)

---

## Files Summary

### New files (7)
| File | Purpose |
|------|---------|
| `supabase/migrations/011_pending_approvals.sql` | Create pending_approvals table + fix FK |
| `src/lib/agent/tools/outcome-tools.ts` | 3 outcome tools (shared logic for both SDK paths): create, update, list |
| `src/lib/agent/planner/outcome-planner.ts` | Constrained DAG planner + replan logic |
| `src/lib/agent/planner/step-executor.ts` | Dual-mode step execution (conversation + background) with timeout + failure handling |
| `src/lib/agent/planner/plan-validator.ts` | Deterministic plan validation (max steps, cycles, tool names, external approval) |
| `src/lib/agent/planner/background-executor.ts` | Background outcome tick: headless tool execution + nudge for blocked steps |
| `src/app/api/cron/outcome-tick/route.ts` | Cron route: every 5 min, advances executing outcomes between conversations |

### Modified files (9)
| File | Changes |
|------|---------|
| `src/lib/agent/openai/captain-tools.ts` | Import + spread outcome tools (OpenAI `tool()` wrappers) into tools array |
| `src/lib/agent/orchestrator.ts` | Add `outcome` MCP server to `buildMcpServers()` + wire outcome stream events in PostToolUse hook |
| `src/lib/agent/context-builder.ts` | Add `'outcome'` to `getRequiredToolSets()` + inject active outcomes into conversation context |
| `src/lib/agent/prompts/captain.ts` | Add outcome creation rules, adjudication guidance, rollout mode commands |
| `src/lib/agent/runtime/rollout-manager.ts` | Default to assisted mode, lower min_interactions to 20, add manual gate for auto |
| `src/lib/intelligence/brief-synthesizer.ts` | Add outcome status to morning brief |
| `src/lib/intelligence/feedback-tracker.ts` | Outcome-linked nudge feedback backflow |
| `src/lib/graph/insight-action-router.ts` | High-confidence insights can create outcomes |
| `vercel.json` | (no change needed — cron is on cron-job.org, not Vercel) |

---

## Implementation Order

```
Week 1:
├── Phase 0: Foundation fixes (day 1)
│   ├── 0a: Create pending_approvals table
│   ├── 0b: Cold start bootstrap (assisted default)
│   └── 0c: Fix outcome_steps FK
│
├── Phase 1a: Outcome tools — DUAL SDK (days 2-3)
│   ├── outcome-tools.ts (shared tool logic)
│   ├── orchestrator.ts: add 'outcome' MCP server to buildMcpServers()
│   ├── context-builder.ts: add 'outcome' to getRequiredToolSets()
│   └── captain-tools.ts: add OpenAI tool() wrappers
│
└── Phase 1e: Prompt update (day 3)
    └── Implicit adjudication instructions

Week 2:
├── Phase 1b: Constrained DAG planner (days 4-5)
│   ├── outcome-planner.ts
│   └── plan-validator.ts
│
├── Phase 1c: Step executor — dual mode (day 6)
│   └── step-executor.ts (conversation + background modes, 30s timeout)
│
├── Phase 1d: Replan logic (day 7)
│   └── Latest-run-wins, max 3 replans
│
├── Phase 1f-g: Stream events + context (day 7)
│   ├── Wire outcome events in orchestrator
│   └── Active outcomes in conversation context
│
└── Phase 1h: Background executor (day 8)  ← THE CHIEF-OF-STAFF LEAP
    ├── background-executor.ts (headless tool execution)
    ├── outcome-tick cron route
    └── Add 9th job to cron-job.org (every 5 min)

Week 3:
├── Phase 2a-b: Intelligence → outcomes (days 9-10)
│   ├── Insight-to-outcome pipeline
│   └── Patrol finding → outcome linking
│
├── Phase 2c-d: Brief + feedback (day 11)
│   ├── Outcome status in morning brief
│   └── Nudge acknowledgment → outcome status
│
└── Phase 3: Trust calibration (days 12-13)
    ├── Manual gate for auto mode
    ├── Outcome metrics in rollout measurement
    └── Rollout mode chat commands

Week 4: Testing + hardening
├── End-to-end testing (BOTH SDK paths!)
├── TypeScript build verification
├── Manual QA: create outcome → plan → execute → complete/fail/replan
└── Background executor QA: create outcome → close chat → verify steps advance → Slack notification
```

---

## Verification Checklist

### Phase 0
- [ ] `pending_approvals` table exists (migration 011 applied)
- [ ] New orgs start in `assisted` mode (not shadow)
- [ ] `outcome_steps.approval_id` FK constraint exists

### Phase 1
- [ ] **Dual SDK parity**: Outcome tools work on Claude path (default) AND OpenAI path
- [ ] `create_outcome` via Claude SDK → outcome row created, run created, steps stored
- [ ] `create_outcome` via OpenAI SDK → same behavior (switch SDK via env var to test)
- [ ] Plan validator rejects: >8 steps, unknown tools, cycles, unguarded external tools
- [ ] Agent executes steps by calling tools → step status updates in real-time
- [ ] 30s timeout fires → step marked 'failed' with timeout message
- [ ] Blocked step (wait_input) → outcome goes 'blocked' with clear ask
- [ ] Failed step → agent can trigger replan → new run version → old run superseded
- [ ] Max 3 replans → outcome fails with "Exceeded maximum replan attempts"
- [ ] `list_outcomes` shows active tasks with blocker summaries
- [ ] Active outcomes appear in conversation context at start
- [ ] Stream events fire: outcome_started, outcome_blocked, outcome_completed
- [ ] Simple questions ("check my email") → no outcome created (implicit adjudication works)
- [ ] Complex tasks ("prep for board meeting") → outcome created with steps
- [ ] **Background executor**: Create outcome with tool_call steps → close chat → wait 5 min → steps execute automatically
- [ ] Background executor skips `llm_reasoning` steps (leaves pending for next chat turn)
- [ ] Background executor skips `wait_approval` steps (sends nudge instead)
- [ ] Background executor sends Slack nudge when outcome completes or blocks
- [ ] Background executor respects 30s timeout per step
- [ ] External tools (send_email, etc.) NEVER execute in background (plan validator enforced wait_approval)

### Phase 2
- [ ] High-confidence insight → outcome created as 'planning', nudge sent to user
- [ ] Patrol finding for commitment with linked outcome → updates outcome blocker
- [ ] Morning brief includes outcome status section
- [ ] Nudge acknowledgment on outcome-linked finding → resumes/cancels outcome

### Phase 3
- [ ] Error rate > 10% → auto-revert to previous rollout mode
- [ ] Advancement to auto requires explicit user command
- [ ] Weekly measurement includes outcome metrics

---

## Cost Impact

| Component | Cost | Frequency |
|-----------|------|-----------|
| Outcome tools (CRUD) | $0 (SQL) | Per tool call |
| DAG planner (LLM call) | $0.01–0.03 | Per outcome created |
| Step execution (conversation) | $0 (reuses existing tools) | Per step |
| Step execution (background) | $0 (reuses existing tools, no LLM) | Per tick per step |
| Background tick (cron) | $0 (SQL + tool calls) | Every 5 min per org |
| Plan validation | $0 (deterministic) | Per plan |
| Replan | $0.01–0.03 | Per replan (max 3) |
| Context injection | $0 (SQL query) | Per conversation start |
| Stream events | $0 | Per event |
| Nudge for blocked step | $0 (template-based) | Per blocked step |

**Worst case per complex task:** $0.09 (1 plan + 3 replans). Most tasks: $0.01–0.03.

**Background execution: $0.** No LLM calls. The planner front-loaded the intelligence; the background executor just runs pre-planned tool calls mechanically.

**No cost increase for simple messages.** Implicit adjudication = zero extra LLM calls for non-outcome messages.

---

## What This Plan Does NOT Include (Intentionally)

1. **Full DAG execution engine with parallel step execution** — Over-engineering for current stage. Steps run sequentially (both in-conversation and background). Parallel execution is a future optimization.

2. **LLM reasoning in background** — The background executor runs tool_call steps mechanically (pre-planned args, no LLM). Steps requiring `llm_reasoning` are deferred to the next chat turn. This keeps background execution at $0 cost.

3. **Nested outcomes** — The schema supports `parent_outcome_id` but the planner explicitly forbids `create_outcome` as a step tool. Nesting adds complexity without clear value now.

4. **Automated rollout advancement** — Auto-advancing to `auto` mode based on metrics alone is risky. The manual gate (user command) ensures the user is in control.

5. **Strategic narrative system** — The v2 spec mentioned narratives for cross-conversation continuity. Memory + outcomes already provide this. Narratives are a polish layer for later.

6. **Multi-org execution** — All operations are per-org. No cross-org outcome sharing.

7. **Recipe integration** — Recipes (workflow templates in `recipes/` directory) could pre-populate outcome steps. Good optimization for later, not needed for v1.

---

## Success Criteria (Manual Evaluation)

After deployment, test these scenarios manually:

1. **Simple question**: "What's on my calendar today?" → Agent calls calendar tool directly, no outcome created
2. **Multi-step task**: "Prepare a status report on the SOC2 audit" → Agent creates outcome with 3-5 steps, executes them, produces report
3. **Blocked task**: "Draft an email to the board about Q1 progress" → Agent creates outcome, executes research steps, blocks at send_email (needs approval), tells user exactly what's needed
4. **Failed step**: "Check Vanta for failing controls and summarize" → If Vanta API fails, step fails, agent reports failure clearly
5. **Replan**: Agent's first plan hits a dead end → creates new run, skips completed work, tries different approach
6. **Proactive outcome**: Ghost agent detects approaching deadline → creates outcome suggestion → nudge sent → user approves → steps execute
7. **Rollout trust**: After 20+ successful interactions, user says "switch to auto mode" → agent processes, mode changes
8. **Background execution (THE chief-of-staff test)**: User says "Gather all failing controls from Vanta and cross-reference with our commitments" → outcome created with tool_call steps → user closes browser → wait 10 minutes → reopen chat → outcome is completed with results waiting → Slack DM was sent when it finished
9. **Background blocked notification**: User creates outcome with a step that needs approval → user closes browser → background tick sees blocked step → sends Slack DM: "Your task is 3/5 done but I need your approval to send the email"
10. **Dual SDK parity**: Set `AGENT_SDK=openai` → repeat scenario 2 → same outcome tool behavior

Each scenario should be tested end-to-end, including the UI (stream events rendering in chat, approval cards working, outcome status displayed).
