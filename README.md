# Agent Zero — AI Captain

A proactive, agentic work companion for individuals and teams. It combines a conversational chat interface (Layer 2) with proactive briefings, nudges, approvals, and connected tools (Layer 1) so the agent can help with real work instead of staying trapped in chat.

## What It Does

- Chat with an agent that can reason over your context and use connected tools.
- Send proactive morning briefs, end-of-day wraps, and nudges through Slack.
- Connect work systems like Slack, Gmail, and Google Calendar via OAuth.
- Gate external actions behind approval flows before messages, emails, or events are created.
- Build memory over time with stored context, graph memory, and meeting/evidence pipelines.

---

## Quick Start

```bash
cp .env.example .env.local
# Fill in the required env vars (see Integration Setup below)
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key (server-only) |
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `TOKEN_ENCRYPTION_SECRET` | ✅ | 32-byte hex string for encrypting OAuth tokens |
| `CRON_SECRET` | ✅ | Random secret for securing `/api/cron/*` endpoints |
| `NEXT_PUBLIC_APP_URL` | ✅ | Public URL (e.g. `https://agentzero.ai` or `http://localhost:3000`) |
| `SLACK_CLIENT_ID` | For Slack | Slack app client ID |
| `SLACK_CLIENT_SECRET` | For Slack | Slack app client secret |
| `SLACK_SIGNING_SECRET` | For Slack | Slack app signing secret |
| `GOOGLE_CLIENT_ID` | For Gmail/Calendar | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | For Gmail/Calendar | Google OAuth client secret |

Generate `TOKEN_ENCRYPTION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Integration Setup

### Slack App

Slack powers both the proactive briefing layer (morning briefs, EOD wraps, nudges) and the interactive approval flow (Approve / Reject / Defer buttons).

**1. Create the app at [api.slack.com/apps](https://api.slack.com/apps)**

Click **Create New App → From scratch**. Name it "Captain" and pick your workspace.

**2. Configure OAuth & Permissions**

In **OAuth & Permissions → Scopes → Bot Token Scopes**, add:

```
channels:read
chat:write
im:write
im:history
users:read
users:read.email
```

In **OAuth & Permissions → Redirect URLs**, add:
```
https://your-app-url.com/api/integrations/callback
```
(Use `http://localhost:3000/api/integrations/callback` for local dev.)

**3. Enable Interactive Components**

In **Interactivity & Shortcuts**, toggle **Interactivity** on and set the **Request URL** to:
```
https://your-app-url.com/api/slack/interactions
```

> ⚠️ This URL must be publicly accessible. Use [ngrok](https://ngrok.com) for local dev: `ngrok http 3000`

**4. Grab your credentials**

- **Client ID** → `SLACK_CLIENT_ID`
- **Client Secret** → `SLACK_CLIENT_SECRET`
- **Signing Secret** (under **Basic Information → App Credentials**) → `SLACK_SIGNING_SECRET`

**5. Install the app**

Click **Install App to Workspace**. After installing, the bot token (`xoxb-...`) is stored per-org in the database when a user connects via OAuth from the app settings.

---

### Google (Gmail + Calendar)

**1. Go to [Google Cloud Console](https://console.cloud.google.com)**

Create a project → **APIs & Services → Enable APIs**. Enable:
- **Gmail API**
- **Google Calendar API**

**2. Create OAuth credentials**

**APIs & Services → Credentials → Create Credentials → OAuth client ID**

- Application type: **Web application**
- Authorized redirect URIs:
  ```
  https://your-app-url.com/api/integrations/callback
  http://localhost:3000/api/integrations/callback
  ```

Copy the **Client ID** → `GOOGLE_CLIENT_ID` and **Client Secret** → `GOOGLE_CLIENT_SECRET`.

**3. Configure the consent screen**

**APIs & Services → OAuth consent screen**
- User type: **External** (or Internal if your Google Workspace org)
- Add scopes: `gmail.readonly`, `calendar.readonly`

---

## Cron Jobs (Layer 1 — Proactive Slack Briefings)

Cron schedules are defined in `vercel.json` and secured with `CRON_SECRET`.

| Endpoint | Schedule (UTC) | Purpose |
|---|---|---|
| `/api/cron/morning-brief` | Every hour 6–14 UTC | Morning brief for users in 6–9 AM local window |
| `/api/cron/eod-wrap` | Every hour 16–23 UTC | EOD wrap for users in 4–7 PM local window |
| `/api/cron/nudge` | 14:00 UTC daily (M–F) | Pending action reminders + onboarding nudges |

**Deduplication**: Each cron checks the `briefs` table before generating — no user gets more than one morning brief or EOD wrap per day regardless of how many times the cron fire.

**Timezone-awareness**: Each profile's `timezone` field (IANA format, e.g. `America/New_York`) controls when they receive briefings.

**To test locally** (requires a public URL or ngrok for Slack):
```bash
# In one terminal:
ngrok http 3000

# In another:
curl -H "Authorization: Bearer your-cron-secret" \
  http://localhost:3000/api/cron/morning-brief
```

---

## Architecture

```
Layer 1 (Push)     → Vercel Crons → Captain → Slack DM
Layer 2 (Conversation) → Chat UI → SSE Stream → Captain → Response Parts
Layer 3 (Dashboard) → Coming soon
```

**Key files:**

```
src/
├── app/api/
│   ├── agent/
│   │   ├── chat/route.ts          # SSE streaming chat endpoint
│   │   └── approve/route.ts       # Approval resolution endpoint
│   ├── cron/
│   │   ├── morning-brief/         # Layer 1: Morning briefing
│   │   ├── eod-wrap/              # Layer 1: EOD wrap
│   │   └── nudge/                 # Layer 1: Reminders
│   ├── integrations/
│   │   ├── [key]/oauth-url/       # OAuth URL generation
│   │   └── callback/              # OAuth callback handler
│   └── slack/interactions/        # Slack button action handler
├── lib/
│   ├── agent/
│   │   ├── orchestrator.ts        # Captain agent runner + canUseTool
│   │   ├── approval-store.ts      # In-process approval promises
│   │   ├── tool-metadata.ts       # Tool → integration mapping
│   │   └── prompts/               # System prompts
│   ├── slack/
│   │   ├── client.ts              # Cached Slack WebClient per org
│   │   ├── blocks.ts              # Block Kit builders
│   │   └── verify.ts              # HMAC request verification
│   └── integrations/
│       ├── registry.ts            # Integration provider registry
│       └── providers/             # Per-integration OAuth handlers
├── components/chat/
│   ├── agentic-message.tsx        # Parts-based message renderer
│   ├── chat-interface.tsx         # Main chat UI
│   └── parts/                     # Approval cards, tool blocks, etc.
└── hooks/use-chat.ts              # SSE consumer + parts assembly
```
