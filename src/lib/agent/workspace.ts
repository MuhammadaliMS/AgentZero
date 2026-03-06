import { mkdir, writeFile, stat } from 'fs/promises'
import { join } from 'path'

// ─── Workspace Management ─────────────────────────────────────────────────
// Creates an ephemeral per-conversation workspace under /tmp.
// The SDK's built-in tools (Bash, Read, Write, Glob, Grep) operate
// relative to the `cwd` option, which points to this workspace.
//
// Structure:
//   /tmp/zerowing-workspace/{orgId}/{conversationId}/
//   ├── CLAUDE.md           ← SDK auto-reads from cwd
//   ├── analysis/           ← Agent-generated intermediate analysis
//   ├── reports/            ← Final deliverables
//   ├── scratch/            ← Temporary working files
//   └── recipes/            ← Markdown workflow templates
//
// Note: /tmp is ephemeral on Vercel — workspace is recreated per cold start.
// This is fine because workspace files are transient working artifacts.

const WORKSPACE_ROOT = '/tmp/zerowing-workspace'

// UUID v4 regex — only accept well-formed UUIDs to prevent path traversal.
// Both orgId and conversationId are Supabase UUIDs generated server-side,
// so this validation is a defensive belt-and-suspenders check.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Get the workspace path for a given org + conversation.
 * Throws if either ID contains path traversal characters (e.g. "../").
 */
export function getWorkspacePath(orgId: string, conversationId: string): string {
  if (!UUID_REGEX.test(orgId) || !UUID_REGEX.test(conversationId)) {
    throw new Error(
      `Invalid workspace path parameters: orgId and conversationId must be UUIDs`
    )
  }
  return join(WORKSPACE_ROOT, orgId, conversationId)
}

/**
 * Ensure the workspace exists with all directories and seed files.
 * Idempotent — safe to call on every request.
 */
export async function ensureWorkspace(orgId: string, conversationId: string): Promise<string> {
  const workspacePath = getWorkspacePath(orgId, conversationId)

  // Check if workspace already exists (fast path for warm invocations)
  try {
    await stat(join(workspacePath, 'CLAUDE.md'))
    return workspacePath
  } catch {
    // Workspace doesn't exist yet — create it
  }

  // Create directory structure
  const dirs = [
    workspacePath,
    join(workspacePath, 'analysis'),
    join(workspacePath, 'reports'),
    join(workspacePath, 'scratch'),
    join(workspacePath, 'recipes'),
  ]

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true })
  }

  // Seed CLAUDE.md — the SDK reads this automatically from cwd
  await writeFile(
    join(workspacePath, 'CLAUDE.md'),
    CLAUDE_MD_CONTENT,
    'utf-8'
  )

  // Seed recipe files
  await Promise.all([
    writeFile(join(workspacePath, 'recipes', 'status-report.md'), RECIPE_STATUS_REPORT, 'utf-8'),
    writeFile(join(workspacePath, 'recipes', 'compliance-audit.md'), RECIPE_COMPLIANCE_AUDIT, 'utf-8'),
    writeFile(join(workspacePath, 'recipes', 'stakeholder-brief.md'), RECIPE_STAKEHOLDER_BRIEF, 'utf-8'),
    writeFile(join(workspacePath, 'recipes', 'meeting-prep.md'), RECIPE_MEETING_PREP, 'utf-8'),
  ])

  return workspacePath
}

// ─── Seed File Contents ───────────────────────────────────────────────────

const CLAUDE_MD_CONTENT = `# Captain — Workspace

## Directories
- \`recipes/\` — Workflow templates for complex tasks. Check these first.
- \`analysis/\` — Intermediate data (fetched emails, calendar events, raw JSON)
- \`reports/\` — Final deliverables (status reports, briefs, meeting prep)
- \`scratch/\` — Temporary working files

## Guidelines
- Use MCP tools to fetch real data — never fabricate
- For multi-step tasks, check \`recipes/\` for a matching template
- Write intermediate results to \`analysis/\`, final output to \`reports/\`
- Verify tool output before summarizing to the user
`

const RECIPE_STATUS_REPORT = `# Recipe: Weekly Status Report

Generate a comprehensive status report for the user's week.

## Steps

1. **Gather commitments**: Call \`query_commitments\` to get all active commitments
2. **Gather action items**: Call \`query_actions\` to get pending and recent actions
3. **Check calendar**: Call \`get_week_events\` to see the week's meetings
4. **Check today's schedule**: Call \`get_today_events\` for today's immediate priorities
5. **Recall context**: Call \`recall_memory\` with query "priorities decisions context" to get background
6. **Analyze & write**: Write a structured report to \`reports/status-report.md\` with:
   - **Executive Summary** (3-5 bullet points of what matters most)
   - **Commitments Status** (on-track, at-risk, overdue)
   - **This Week's Key Meetings** (purpose and prep needed)
   - **Action Items** (pending decisions, blocked items)
   - **Recommendations** (what to prioritize, what to delegate)
7. **Verify**: Re-read the report to confirm quality
8. **Present**: Share the report content with the user
`

const RECIPE_COMPLIANCE_AUDIT = `# Recipe: Platform Health Review

Perform a platform health check and generate a readiness report.

## Steps

1. **Get platform overview**: Call \`get_compliance_overview\` for the current posture
2. **List failing checks**: Call \`list_failing_controls\` to identify gaps
3. **Check status**: Call \`get_audit_status\` for upcoming timeline
4. **Recall context**: Call \`recall_memory\` with query "platform health remediation" for historical context
5. **Analyze & write**: Write a structured report to \`reports/platform-health.md\` with:
   - **Platform Health Summary** (overall health score, framework status)
   - **Critical Gaps** (failing checks ranked by severity)
   - **Timeline** (upcoming milestones, deadlines)
   - **Remediation Priorities** (what to fix first, estimated effort)
   - **Risk Narrative** (executive-friendly summary for leadership)
6. **Verify**: Re-read the report to confirm accuracy
7. **Present**: Share findings with the user, leading with what needs immediate attention
`

const RECIPE_STAKEHOLDER_BRIEF = `# Recipe: Stakeholder Brief

Prepare a stakeholder communication brief for executive updates.

## Steps

1. **Gather commitments**: Call \`query_commitments\` for deliverable status
2. **Check recent emails**: Call \`read_recent_emails\` for recent stakeholder communications
3. **Recall context**: Call \`recall_memory\` with query "stakeholder relationships preferences communication" for context
4. **Check calendar**: Call \`get_week_events\` for upcoming stakeholder meetings
5. **Analyze & write**: Write a brief to \`reports/stakeholder-brief.md\` with:
   - **Key Messages** (2-3 talking points per stakeholder)
   - **Commitment Updates** (what to communicate about deliverables)
   - **Risk Items** (what to flag proactively)
   - **Preparation Notes** (meeting-specific prep for upcoming conversations)
   - **Recommended Actions** (follow-ups, escalations, acknowledgments)
6. **Verify**: Re-read the brief to confirm it's actionable
7. **Present**: Share the brief with the user
`

const RECIPE_MEETING_PREP = `# Recipe: Meeting Preparation

Prepare the user for their next meeting with comprehensive context.

## Steps

1. **Check calendar**: Call \`get_today_events\` to find the next meeting (time, attendees, topic/agenda)
2. **Recall context**: Call \`recall_memory\` with query about the meeting topic, attendees, and related projects
3. **Search email for context**: Call \`search_emails\` with attendee names and/or meeting topic to find:
   - Previous meeting summaries (from meeting bot tools like Otter, Fireflies, Fathom, etc.)
   - Recent correspondence with attendees
   - Related documents, briefs, or action items shared via email
   - Any follow-ups or open threads from prior meetings
4. **Read recent emails**: Call \`read_recent_emails\` to catch any last-minute context or updates
5. **Check commitments**: Call \`query_commitments\` to find commitments related to meeting attendees or topics
6. **Check action items**: Call \`query_actions\` for pending actions related to the meeting context
7. **Synthesize prep brief**: Write to \`reports/meeting-prep.md\` with:
   - **Meeting Details** (time, attendees, agenda if available)
   - **Context from Previous Meetings** (key decisions, open items from prior discussions)
   - **Email Context** (relevant recent emails, meeting bot summaries)
   - **Active Commitments** (what you owe attendees, what they owe you)
   - **Talking Points** (recommended topics to raise, questions to ask)
   - **Preparation Checklist** (materials to review, data to have ready)
8. **Verify**: Re-read the prep to confirm quality and completeness
9. **Present**: Share the prep with the user, leading with the most critical context
`
