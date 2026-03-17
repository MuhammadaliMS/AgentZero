# Agent Zero — AI Chief-of-Staff

An open-source AI agent that acts as your Chief-of-Staff. It reads your emails, summarizes Slack, sends morning briefs, tracks commitments from meetings, nudges you when things slip, and runs an hourly intelligence loop — all from a chat interface or deployed as a Slack bot.

Built as a deep exploration of **Claude Agent SDK vs OpenAI Agents SDK** — same 33 tools, same streaming chat, same approval gates, two different engines.

> **This repo is open source.** Clone it, run it, break it, learn from it.

---

## What's Inside

- **Dual SDK architecture** — Claude Agent SDK and OpenAI Agents SDK running behind a single runtime switch. Same tools, same streaming, same client experience.
- **33 agent tools** — Memory, Slack, Gmail, Calendar, Compliance (Vanta), Knowledge Graph, Outcomes, Integrations, Directory.
- **6 integrations** — Slack, Gmail, Google Calendar, Vanta, Google Workspace Directory, Meeting Bot.
- **Approval flows** — External actions (send email, post in Slack, create event) require explicit approval via in-chat cards. Database-backed, survives serverless restarts.
- **Progressive autonomy** — Shadow → Assisted → Auto. Trust is earned through acceptance rate metrics, not configuration.
- **Hybrid memory** — Full-text search + vector embeddings + knowledge graph with contradiction detection.
- **Meeting bot** — Transcripts → action items, decisions, entity extraction → commitments, graph updates, vault documents.
- **Knowledge vault** — Structured knowledge base organized by source (meetings, Slack, email) and entity type (people, projects, tools).
- **Hourly intelligence loop** — Gathers signals from all sources, runs parallel sub-agents (triage, analyst, executor, graph), acts, reflects.
- **Cron-driven proactive layer** — Morning briefs, EOD wraps, smart nudges, background outcome execution, evidence sync.
- **Slack bot deployment** — Morning summaries, daily priorities, deadline nudges, approval buttons — all in Slack DMs.
- **Streaming chat UI** — SSE-based with thinking steps, tool call visualization, approval cards, integration prompts, subagent delegation.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Zero                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Layer 1 (Push)         Vercel Crons → Intelligence Loop         │
│                         → Slack DM (briefs, nudges, wraps)       │
│                                                                  │
│  Layer 2 (Conversation) Chat UI → SSE Stream → Captain Agent     │
│                         → Tool calls, approvals, memory          │
│                                                                  │
│  Layer 3 (Intelligence) Chief Loop → Sub-agents → Graph          │
│                         → Vault → Evidence → Learning            │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  SDK Layer              Claude Agent SDK ←→ OpenAI Agents SDK    │
│                         (runtime switch, same interface)         │
├─────────────────────────────────────────────────────────────────┤
│  Integrations           Slack · Gmail · Calendar · Vanta         │
│                         Google Directory · Meeting Bot           │
├─────────────────────────────────────────────────────────────────┤
│  Storage                Supabase (DB + Auth)                     │
│                         Vector embeddings (OpenAI via OpenRouter) │
│                         Knowledge graph (entities + relationships)│
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

```bash
git clone https://github.com/your-username/agent-zero.git
cd agent-zero
cp .env.example .env.local
# Fill in required env vars (see below)
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in:

### Required

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-only) |
| `ANTHROPIC_API_KEY` | Claude API key (for Claude SDK path) |
| `TOKEN_ENCRYPTION_SECRET` | 32-byte hex string for encrypting OAuth tokens |
| `CRON_SECRET` | Random secret for securing `/api/cron/*` endpoints |
| `NEXT_PUBLIC_APP_URL` | Public URL (`http://localhost:3000` for dev) |

### Integrations (enable as needed)

| Variable | For |
|---|---|
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` | Slack |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail + Google Calendar |
| `VANTA_CLIENT_ID` / `VANTA_CLIENT_SECRET` | Vanta compliance |
| `NVIDIA_API_KEY` | NVIDIA NIM (primary LLM for background agents) |
| `OPENROUTER_API_KEY` | OpenRouter (fallback LLM + embeddings) |

Generate `TOKEN_ENCRYPTION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Integration Setup

### Slack App

Slack powers proactive briefings (morning briefs, EOD wraps, nudges) and interactive approval flows (Approve / Reject buttons).

**1. Create the app** at [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch.

**2. OAuth & Permissions** — Add Bot Token Scopes:
```
channels:read  chat:write  im:write  im:history  users:read  users:read.email
```

Add Redirect URL:
```
https://your-app-url.com/api/integrations/callback
```

**3. Interactivity** — Toggle on, set Request URL to:
```
https://your-app-url.com/api/slack/interactions
```
> Use [ngrok](https://ngrok.com) for local dev: `ngrok http 3000`

**4. Grab credentials** — Client ID, Client Secret, Signing Secret → env vars.

**5. Bot vs User tokens** — Bot tokens (`xoxb-`) work for posting in channels and DMs. User tokens (`xoxp-`) are needed for posting on behalf of a user and accessing external shared channels. The app handles both via OAuth.

### Google (Gmail + Calendar)

**1.** Go to [Google Cloud Console](https://console.cloud.google.com) → Create project → Enable **Gmail API** and **Google Calendar API**.

**2.** Create OAuth credentials (Web application) with redirect URIs:
```
https://your-app-url.com/api/integrations/callback
http://localhost:3000/api/integrations/callback
```

**3.** Configure OAuth consent screen → Add scopes: `gmail.readonly`, `gmail.send`, `calendar.readonly`, `calendar.events`.

> **Heads up**: Google Cloud Console setup takes time — consent screen review, scope approval, test user configuration. Budget an afternoon for first-time setup.

---

## Agent Tools (33)

| Category | Tools |
|---|---|
| **Memory** | `recall_memory`, `store_memory`, `update_memory` |
| **Knowledge Graph** | `query_entity_graph`, `get_entity_timeline` |
| **Email** | `read_recent_emails`, `search_emails`, `read_email`, `draft_email`, `send_email` |
| **Slack** | `read_channels`, `read_thread`, `read_dms`, `read_mentions`, `send_dm`, `post_to_channel`, `send_approval_message` |
| **Calendar** | `get_today_events`, `get_week_events`, `find_free_slots`, `create_calendar_event` |
| **Directory** | `lookup_workspace_user` |
| **Compliance** | `get_compliance_overview`, `list_failing_controls`, `get_audit_status` |
| **Outcomes** | `create_outcome`, `update_outcome`, `list_outcomes` |
| **Integration** | `list_connected_integrations`, `get_integration_health` |
| **Internal** | `query_commitments`, `query_actions` |

Tools requiring external action (send email, post to Slack, create event) go through the **approval gate**. If an integration isn't connected, the agent prompts for OAuth connection inline in the chat.

---

## Cron Jobs

Defined in Vercel cron configuration, secured with `CRON_SECRET`.

| Endpoint | Schedule | Purpose |
|---|---|---|
| `/api/cron/chief-loop` | Hourly | 6-phase intelligence loop (gather → think → act → reflect) |
| `/api/cron/morning-brief` | Hourly 6–14 UTC | Morning brief for users in 6–9 AM local window |
| `/api/cron/eod-wrap` | Hourly 16–23 UTC | EOD wrap for users in 4–7 PM local window |
| `/api/cron/nudge` | 14:00 UTC daily (M–F) | Smart nudges with urgency scoring + cooldowns |
| `/api/cron/outcome-tick` | Every 5 min | Background outcome step execution ($0 — no LLM) |
| `/api/cron/evidence-sync` | Periodic | Evidence pipeline: normalize + store artifacts in vault |
| `/api/cron/meeting-summarize` | On trigger | Process meeting transcripts → structured output |
| `/api/cron/weekly-tuning` | Weekly | Performance measurement + rollout adjustment |

**Vercel cron limits**: 300s execution. Long workflows (chief loop) chain phases via HTTP self-triggers.

Test locally:
```bash
curl -H "Authorization: Bearer your-cron-secret" http://localhost:3000/api/cron/morning-brief
```

---

## Intelligence System

### Chief Loop (runs hourly)

1. **Lock** — Acquire org lease (prevent concurrent runs)
2. **Gather** — Fetch emails, Slack messages, calendar events, commitments, entity graph
3. **Think** — 4 parallel sub-agents: Triage, Analyst, Executor, Graph Agent
4. **Act** — Create outcomes, update knowledge graph, send nudges, escalate blockers
5. **Reflect** — Self-evaluate decisions, store procedural memories
6. **Closeout** — Persist metrics, release lease

Budget limits per cycle: 3 new outcomes, 10 step executions, 50 agent turns.

### Specialist Agents

| Agent | Role |
|---|---|
| **Captain** | Main conversational agent (chat interface) |
| **Eve** | Strategy sub-agent |
| **Cole** | Operations sub-agent |
| **Rhea** | Compliance sub-agent |
| **Patrol Scanner** | Deadline, blocker, stale entity detection |
| **Ghost Agent** | Proactive signal generation for upcoming events |
| **Nudge Engine** | Smart notification scoring + delivery |

### Outcomes (Multi-step Task Tracking)

- Status flow: `planning → executing → completed/failed/blocked`
- Each outcome has runs with ordered steps
- Step types: `tool_call`, `llm_reasoning`, `wait_input`, `wait_approval`
- Background executor advances `tool_call` steps between conversations for $0
- Max 8 steps per plan, auto-replan on failure (up to 3 versions)

---

## Memory & Knowledge Graph

### Hybrid Memory Search

- **Full-text** (websearch) — Fast keyword matching
- **Vector** (embeddings) — Semantic similarity via OpenAI embeddings
- **Graph traversal** — Entity relationships and connected context

Weighted scoring: text 0.3, vector 0.4, graph context embedded.

### 10 Memory Categories

`decision` · `context` · `preference` · `relationship` · `fact` · `task` · `meeting_outcome` · `project_status` · `blocker` · `deadline`

### Features

- **Contradiction detection** — Checks for conflicting facts before storing
- **Strategic memory** — Compresses long narratives into strategic arcs
- **Associative recall** — Builds entity subgraph per conversation for contextual awareness
- **Entity resolution** — Deduplicates entities across sources (email, Slack, meetings)

---

## Meeting Bot

Pipeline: **Recording → Transcript → LLM Processing → Structured Output → Vault**

Extracts:
- Executive summary + TLDR
- Action items (owner, due date, priority P0–P3, context quote)
- Decisions (rationale, who decided, stakeholders)
- Topic breakdown

Then:
- Action items → tracked **commitments** (show up in morning briefs, trigger nudges)
- Decisions → **knowledge graph** updates
- Speaker attribution → **entity resolution** (maps "Speaker 1" to real people)
- Everything → **vault document** in `Sources/Meetings/`

---

## SDK Comparison: Claude vs OpenAI

Both paths are fully implemented and share identical tool sets, streaming behavior, and approval gates.

| | Claude Agent SDK | OpenAI Agents SDK |
|---|---|---|
| **Tool definition** | `tool()` with Zod schemas + MCP servers | Wrapped functions returning strings |
| **Permission gating** | PreToolUse/PostToolUse hooks | Inside tool wrappers |
| **Sub-agents** | SubagentStart/SubagentStop hooks | Agent handoff definitions |
| **Streaming** | Native stream events | Runner stream chunks |
| **Model** | Claude Haiku 4.5 (Sonnet for sub-agents) | Qwen / NVIDIA NIM / OpenRouter |

Switch between SDKs per-org or via environment variable. Both emit identical SSE events to the client.

---

## Cost Architecture

| Component | Cost | Notes |
|---|---|---|
| Chat turn (Captain) | $0.01–0.10 | Per user message |
| Chief loop turn | $0.02–0.05 | Hourly per org |
| Meeting summarization | $0.01–0.05 | Per meeting |
| Outcome planner | $0.01–0.03 | Per outcome (if LLM plans) |
| Memory vector search | ~$0.001 | Per recall |
| Background executor | **$0** | Pre-planned tool calls, no LLM |
| Morning brief | **$0** | Pure SQL + template |

Model routing keeps costs manageable: Claude Haiku for conversation, Qwen/Kimi via NVIDIA NIM or OpenRouter for background intelligence.

---

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── agent/
│   │   │   ├── chat/route.ts              # SSE streaming chat endpoint
│   │   │   └── approve/route.ts           # Approval resolution
│   │   ├── cron/
│   │   │   ├── chief-loop/                # Hourly intelligence loop
│   │   │   ├── morning-brief/             # Morning briefing
│   │   │   ├── eod-wrap/                  # EOD wrap
│   │   │   ├── nudge/                     # Smart nudges
│   │   │   ├── outcome-tick/              # Background outcome executor
│   │   │   ├── evidence-sync/             # Evidence pipeline
│   │   │   ├── meeting-summarize/         # Meeting processing
│   │   │   └── weekly-tuning/             # Performance tuning
│   │   ├── integrations/                  # OAuth flows
│   │   ├── slack/interactions/            # Slack button handler
│   │   ├── meetings/                      # Meeting management
│   │   ├── settings/                      # Settings API
│   │   └── vault/                         # Vault API
│   ├── (app)/                             # App routes (authenticated)
│   └── (auth)/                            # Auth routes
├── lib/
│   ├── agent/
│   │   ├── orchestrator.ts                # Captain (Claude SDK) — main agent loop
│   │   ├── sdk-switch.ts                  # Dual SDK runtime dispatcher
│   │   ├── openai/                        # OpenAI SDK implementation
│   │   ├── tools/                         # 33 tool implementations
│   │   │   ├── memory-tools.ts            # Hybrid recall + store + graph
│   │   │   ├── slack-tools.ts             # Slack read/write
│   │   │   ├── email-tools.ts             # Gmail operations
│   │   │   ├── calendar-tools.ts          # Calendar events
│   │   │   ├── outcome-tools.ts           # Multi-step task tracking
│   │   │   ├── vanta-tools.ts             # Compliance
│   │   │   └── ...
│   │   ├── workers/                       # Sub-agents (Eve, Cole, Rhea)
│   │   ├── planner/                       # Outcome planning + step execution
│   │   ├── reasoning/                     # Thinking steps + extended reasoning
│   │   ├── prompts/                       # System prompts
│   │   ├── approval-store.ts              # DB-backed approval gate
│   │   ├── hooks.ts                       # SDK hook callbacks
│   │   └── tool-metadata.ts              # Tool → integration mapping
│   ├── intelligence/
│   │   ├── chief-loop.ts                  # 6-phase intelligence orchestration
│   │   ├── meeting-processor.ts           # Transcript → structured output
│   │   ├── nudge-engine.ts                # Smart notification scoring
│   │   ├── ghost-agent.ts                 # Proactive signal generation
│   │   ├── patrol-scanner.ts              # Deadline/blocker detection
│   │   ├── brief-synthesizer.ts           # Morning/EOD brief assembly
│   │   ├── speaker-attribution.ts         # Meeting speaker → entity mapping
│   │   └── world-model.ts                # Org state tracking
│   ├── graph/
│   │   ├── entity-resolution.ts           # Entity deduplication
│   │   ├── extraction-pipeline.ts         # Entity/relationship extraction
│   │   ├── associative-recall.ts          # Context-aware subgraph building
│   │   ├── contradiction-detector.ts      # Conflicting fact detection
│   │   ├── strategic-memory.ts            # Long-term narrative compression
│   │   └── utility-tracker.ts            # Decision feedback tracking
│   ├── evidence/
│   │   ├── vault.ts                       # Knowledge vault structure
│   │   ├── vault-author.ts                # Auto-generate vault sections
│   │   ├── pipeline.ts                    # Evidence processing pipeline
│   │   └── store.ts                       # Evidence persistence
│   ├── integrations/                      # OAuth providers + token management
│   ├── slack/                             # Slack client, blocks, verification
│   └── supabase/                          # DB client + helpers
├── components/
│   └── chat/
│       ├── chat-interface.tsx             # Main chat UI
│       ├── agentic-message.tsx            # Parts-based message renderer
│       └── parts/                         # Approval cards, tool blocks, etc.
└── hooks/
    └── use-chat.ts                        # SSE consumer + parts assembly
```

---

## Tech Stack

- **Framework**: Next.js 16 + React 19
- **Agent SDKs**: Claude Agent SDK + OpenAI Agents SDK
- **Database**: Supabase (Postgres + Auth + Realtime)
- **LLMs**: Claude (Haiku/Sonnet), Qwen 3.5, Kimi K2.5 via NVIDIA NIM / OpenRouter
- **Embeddings**: OpenAI text-embedding-3-small via OpenRouter
- **Integrations**: Slack Web API, Gmail API, Google Calendar API, Vanta API
- **UI**: Tailwind CSS, Radix UI, shadcn/ui, Lucide icons
- **Deployment**: Vercel (with cron jobs)
- **Testing**: Vitest

---

## Contributing

This is an open-source learning project. PRs, issues, and discussions are welcome.

```bash
npm run dev       # Start dev server
npm run lint      # Run linter
npm run test      # Run tests
npm run build     # Production build
```

---

## License

MIT
