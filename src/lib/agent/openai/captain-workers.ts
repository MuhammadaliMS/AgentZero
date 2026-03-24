/**
 * OpenAI Agents SDK — Captain Sub-Agents (Workers)
 *
 * Mirrors the Claude SDK's subagent architecture (Eve, Cole, Rhea)
 * using OpenAI SDK's `handoff()` mechanism.
 *
 * In the Claude SDK, these are defined as `AgentDefinition` objects and passed
 * via `agents: { eve, cole, rhea }` to `query()`. The SDK automatically:
 *   - Presents them as delegatable agents
 *   - Transfers conversation history when delegating
 *   - Restricts tools to the allowed/disallowed lists
 *
 * In the OpenAI SDK, we use the `handoff()` function which:
 *   - Creates a tool that the Captain can invoke to delegate
 *   - Transfers the full conversation history to the sub-agent
 *   - Sub-agent runs with its own instructions, model, and tool subset
 *
 * Tool subsets match exactly what each Claude SDK worker definition allows.
 */

import { Agent, handoff } from '@openai/agents'
import type { Handoff } from '@openai/agents'
import { z } from 'zod'
import { EVE_PROMPT } from '../prompts/eve-prompt'
import { COLE_PROMPT } from '../prompts/cole-prompt'
import { RHEA_PROMPT } from '../prompts/rhea-prompt'
import { createCaptainToolsMap, type CaptainToolParams } from './captain-tools'

// ─── Sub-Agent Model ────────────────────────────────────────────────────────
// Claude SDK uses 'sonnet' for all workers. For OpenAI SDK, we use a
// configurable model via env var, defaulting to qwen/qwen3.5-397b-a17b (capable model
// for specialist work, similar to how sonnet > haiku in Claude SDK).

const WORKER_MODEL = process.env.OPENAI_WORKER_MODEL || 'qwen/qwen3.5-397b-a17b'

// ─── Tool Lists (matching Claude SDK worker definitions exactly) ─────────────

/**
 * Eve — Strategy Analyst
 * Source: src/lib/agent/workers/eve.ts
 *
 * Allowed: read-only research + strategy tools
 * Disallowed: Bash, Write, Slack sends, compliance tools
 */
const EVE_ALLOWED_TOOLS = [
  // MCP tools
  'recall_memory',
  'store_memory',
  'update_memory',
  'query_commitments',
  'create_commitment',
  'read_recent_emails',
  'search_emails',
  'draft_email',
  'get_today_events',
  'get_week_events',
  'list_connected_integrations',
  // Slack read (context gathering for stakeholder analysis)
  'list_slack_channels',
  'read_slack_channel',
  'read_slack_thread',
  'read_slack_dms',
  'get_slack_mentions',
]

/**
 * Cole — Program Manager
 * Source: src/lib/agent/workers/cole.ts
 *
 * Allowed: full operational toolkit (except compliance + email)
 * Disallowed: compliance, email tools
 */
const COLE_ALLOWED_TOOLS = [
  // MCP tools
  'recall_memory',
  'store_memory',
  'update_memory',
  'query_commitments',
  'create_commitment',
  'update_commitment',
  'query_actions',
  'create_action',
  'resolve_action',
  'get_today_events',
  'get_week_events',
  'find_free_slots',
  'send_slack_dm',
  'send_approval_message',
  'list_connected_integrations',
  // Slack read (context gathering for PM coordination)
  'list_slack_channels',
  'read_slack_channel',
  'read_slack_thread',
  'read_slack_dms',
  'get_slack_mentions',
]

/**
 * Rhea — GRC Analyst
 * Source: src/lib/agent/workers/rhea.ts
 *
 * Allowed: compliance-focused + memory + commitments
 * Disallowed: email, all Slack, calendar
 */
const RHEA_ALLOWED_TOOLS = [
  // MCP tools
  'recall_memory',
  'store_memory',
  'update_memory',
  'query_commitments',
  'create_commitment',
  'update_commitment',
  'get_compliance_overview',
  'list_failing_controls',
  'get_audit_status',
  'query_actions',
  'create_action',
  'list_connected_integrations',
  'get_integration_health',
]

// ─── Helper: Pick tools by name ─────────────────────────────────────────────

function pickTools(
  toolMap: Record<string, ReturnType<typeof import('@openai/agents').tool>>,
  allowedNames: string[]
): ReturnType<typeof import('@openai/agents').tool>[] {
  const result: ReturnType<typeof import('@openai/agents').tool>[] = []
  for (const name of allowedNames) {
    const t = toolMap[name]
    if (t) result.push(t)
  }
  return result
}

// ─── Create Sub-Agents + Handoffs ───────────────────────────────────────────

/**
 * Create the three specialist sub-agents and return them as OpenAI SDK handoffs.
 *
 * These handoffs are passed to the Captain's `handoffs` array, enabling the
 * Captain to delegate tasks to specialists — the same pattern as Claude SDK's
 * `agents: { eve, cole, rhea }` option.
 *
 * Each sub-agent:
 * - Has its own system prompt (from prompts/*.ts)
 * - Receives only its allowed tool subset (principle of least privilege)
 * - Gets a handoffDescription matching the Claude SDK's `description` field
 * - Runs with the worker model (configurable via OPENAI_WORKER_MODEL)
 */
export function createCaptainHandoffs(
  toolParams: CaptainToolParams
): Handoff[] {
  // Build the named tool map once — shared across all sub-agents
  const toolMap = createCaptainToolsMap(toolParams)

  // ─── Eve — Strategy Analyst ─────────────────────────────────────────

  const eveAgent = new Agent({
    name: 'eve',
    instructions: EVE_PROMPT,
    model: WORKER_MODEL,
    tools: pickTools(toolMap, EVE_ALLOWED_TOOLS),
    handoffDescription:
      'Strategy Analyst for board narratives, QBR preparation, executive communications, and stakeholder management. Delegate to Eve when the user asks about: board prep, executive emails, QBR content, strategic narratives, stakeholder updates, risk communication, or C-suite talking points.',
  })

  // ─── Cole — Program Manager ─────────────────────────────────────────

  const coleAgent = new Agent({
    name: 'cole',
    instructions: COLE_PROMPT,
    model: WORKER_MODEL,
    tools: pickTools(toolMap, COLE_ALLOWED_TOOLS),
    handoffDescription:
      'Program Manager for commitment tracking, OKRs, accountability, action items, and status reporting. Delegate to Cole when the user asks about: tracking commitments, deliverable status, deadline management, action items, status reports, OKR health, meeting prep, or cross-functional coordination.',
  })

  // ─── Rhea — GRC Analyst ─────────────────────────────────────────────

  const rheaAgent = new Agent({
    name: 'rhea',
    instructions: RHEA_PROMPT,
    model: WORKER_MODEL,
    tools: pickTools(toolMap, RHEA_ALLOWED_TOOLS),
    handoffDescription:
      'GRC Analyst for compliance frameworks, audit readiness, control monitoring, risk assessment, and POAM tracking. Delegate to Rhea when the user asks about: SOC2/ISO/HIPAA/PCI compliance, audit prep, control status, compliance posture, vendor risk, evidence collection, POAM, or remediation plans.',
  })

  // ─── Create Handoffs ────────────────────────────────────────────────
  // Using handoff() gives us more control than passing agents directly.
  // We can add onHandoff callbacks for logging/observability.

  const eveHandoff = handoff(eveAgent, {
    toolNameOverride: 'transfer_to_eve',
    toolDescriptionOverride:
      'Delegate to Eve (Strategy Analyst) for board narratives, QBR prep, executive communications, and stakeholder management.',
    inputType: z.object({}),
    onHandoff: async () => {
      console.log(`[Captain:Handoff] Delegating to Eve (Strategy Analyst)`)
      toolParams.onEmitEvent?.({
        type: 'subagent_start',
        agentId: 'eve',
        content: 'Delegating to specialist: Eve (Strategy Analyst)',
      })
    },
  })

  const coleHandoff = handoff(coleAgent, {
    toolNameOverride: 'transfer_to_cole',
    toolDescriptionOverride:
      'Delegate to Cole (Program Manager) for commitment tracking, OKRs, action items, status reporting, and cross-functional coordination.',
    inputType: z.object({}),
    onHandoff: async () => {
      console.log(`[Captain:Handoff] Delegating to Cole (Program Manager)`)
      toolParams.onEmitEvent?.({
        type: 'subagent_start',
        agentId: 'cole',
        content: 'Delegating to specialist: Cole (Program Manager)',
      })
    },
  })

  const rheaHandoff = handoff(rheaAgent, {
    toolNameOverride: 'transfer_to_rhea',
    toolDescriptionOverride:
      'Delegate to Rhea (GRC Analyst) for compliance frameworks, audit readiness, control monitoring, risk assessment, and POAM tracking.',
    inputType: z.object({}),
    onHandoff: async () => {
      console.log(`[Captain:Handoff] Delegating to Rhea (GRC Analyst)`)
      toolParams.onEmitEvent?.({
        type: 'subagent_start',
        agentId: 'rhea',
        content: 'Delegating to specialist: Rhea (GRC Analyst)',
      })
    },
  })

  return [eveHandoff, coleHandoff, rheaHandoff]
}
