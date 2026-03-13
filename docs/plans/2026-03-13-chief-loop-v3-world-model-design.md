# Chief Loop V3 World Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Evolve the chief loop from an hourly triage engine into a persistent operator over initiatives, evidence, and the vault.

**Architecture:** Keep the evidence graph as canonical truth and Vault V2 as the human-readable workspace, but add a durable `initiative` layer plus a richer `chief_world_model`. The chief loop will gather changed signals and changed state, load only affected initiatives plus top strategic initiatives, run Kimi over initiative-scoped context, apply updates, and selectively regenerate vault docs.

**Tech Stack:** Next.js 16, TypeScript, Supabase/Postgres, OpenAI Agents SDK, existing evidence graph (`source_artifacts`, `claims`, `decision_threads`, `commitments`, `vault_documents`), Vitest.

---

## Current State Summary

The current chief loop in [/Users/muhammadali/AxariV2/src/lib/intelligence/chief-loop.ts](/Users/muhammadali/AxariV2/src/lib/intelligence/chief-loop.ts) already has a real agentic `THINK` phase, but `phaseGather` still operates mainly on:
- recent emails
- recent Slack
- today’s events
- active outcomes
- insights/findings
- top entities and relationships
- recent memories
- worker views
- lightweight `working_memory`

It does **not** yet treat the evidence graph, Vault V2 documents, or long-horizon initiative state as first-class chief cognition inputs.

The evidence/vault side already exists in:
- [/Users/muhammadali/AxariV2/src/lib/evidence/context-pack.ts](/Users/muhammadali/AxariV2/src/lib/evidence/context-pack.ts)
- [/Users/muhammadali/AxariV2/src/lib/evidence/store.ts](/Users/muhammadali/AxariV2/src/lib/evidence/store.ts)
- [/Users/muhammadali/AxariV2/src/lib/evidence/vault.ts](/Users/muhammadali/AxariV2/src/lib/evidence/vault.ts)
- [/Users/muhammadali/AxariV2/src/lib/evidence/vault-author.ts](/Users/muhammadali/AxariV2/src/lib/evidence/vault-author.ts)

The implementation goal is to join those two worlds cleanly.

## Design Principles

1. The evidence graph remains the canonical truth.
2. The vault becomes both a human surface and a chief-readable planning surface.
3. Initiative state becomes the durable long-horizon memory primitive.
4. Kimi is used for synthesis, continuity, conflict resolution, and next-best action planning.
5. Deterministic code still owns storage, validation, linking, scheduling, and execution bookkeeping.
6. Each hourly loop reasons over changed initiatives, not the whole org from zero.

## New Data Model

### A. `initiatives`

Create a new table in a migration such as:
- Create: `/Users/muhammadali/AxariV2/supabase/migrations/029_chief_loop_v3_world_model.sql`

Schema:
- `id uuid primary key`
- `org_id uuid not null`
- `title text not null`
- `goal text not null`
- `scope text`
- `status text check in ('active','waiting','blocked','closed','archived')`
- `phase text check in ('discovery','alignment','planning','execution','waiting','verification','closed')`
- `success_criteria jsonb not null default '[]'`
- `current_hypothesis text`
- `open_questions jsonb not null default '[]'`
- `known_risks jsonb not null default '[]'`
- `dependencies jsonb not null default '[]'`
- `stakeholders jsonb not null default '[]'`
- `linked_entity_ids uuid[] not null default '{}'`
- `linked_claim_ids uuid[] not null default '{}'`
- `linked_commitment_ids uuid[] not null default '{}'`
- `linked_decision_thread_ids uuid[] not null default '{}'`
- `latest_summary text`
- `next_milestone text`
- `next_review_at timestamptz`
- `last_signal_at timestamptz`
- `last_reconciled_at timestamptz`
- `source text default 'chief_loop'`
- `created_at timestamptz`
- `updated_at timestamptz`

Indexes:
- `(org_id, status, updated_at desc)`
- GIN on linked ids arrays
- `(org_id, next_review_at)`

### B. `chief_world_model`

Add a second table:
- `org_id uuid primary key`
- `operational_memory jsonb`
- `narrative_memory jsonb`
- `execution_memory jsonb`
- `initiative_priorities jsonb`
- `changed_since_last_run jsonb`
- `version integer`
- `updated_at timestamptz`

This is distinct from `working_memory`.
- `working_memory` remains the compact run-to-run scratchpad.
- `chief_world_model` becomes the durable org-level world model.

### C. Optional bridge table: `initiative_vault_links`

Only add if needed after implementation pressure is clear.
Initially, initiative-to-vault links can be stored in arrays and `vault_document_links`.

## Chief Gather V2

### Files
- Modify: [/Users/muhammadali/AxariV2/src/lib/intelligence/chief-loop.ts](/Users/muhammadali/AxariV2/src/lib/intelligence/chief-loop.ts)
- Modify: [/Users/muhammadali/AxariV2/src/lib/evidence/context-pack.ts](/Users/muhammadali/AxariV2/src/lib/evidence/context-pack.ts)
- Create: `/Users/muhammadali/AxariV2/src/lib/intelligence/chief-world-model.ts`

### Gather Result additions

Extend `GatherResult` to include:
- `recentMeetings`
- `recentChatArtifacts`
- `activeClaims`
- `activeCommitments`
- `decisionThreads`
- `activeNarratives`
- `recentSourceArtifacts`
- `changedEvidenceItems`
- `initiativeCandidates`
- `activeInitiatives`
- `topStrategicInitiatives`
- `vaultContext`
- `chiefWorldModel`

### Fetch strategy

Fresh signals:
- source artifacts from last 24h for `meeting`, `chat`, `email`, `slack`
- changed evidence items for changed artifacts

Canonical state:
- active claims related to changed entities/artifacts
- active commitments
- decision threads
- active strategic narratives

Vault context:
- account docs
- relationship docs
- initiative docs
- briefs updated in the last 7 days
- changed sections / previous summaries

Project world model:
- active initiatives
- due-for-review initiatives
- initiatives linked to changed claims/artifacts

### Important optimization

Do **not** load the entire vault or all claims every run.
Compute an `affectedEntityIds` / `affectedArtifactIds` set first, then hydrate only:
- initiatives touching those ids
- top strategic initiatives by `next_review_at` or freshness

## Initiative Lifecycle

### Initiative creation and reconciliation

Add helper module:
- Create: `/Users/muhammadali/AxariV2/src/lib/intelligence/initiative-state.ts`

Responsibilities:
- infer whether changed signals belong to an existing initiative
- create new initiative when no existing initiative fits
- update linked ids when claims/commitments/threads change
- move phase based on changed evidence and chief decisions
- compute `next_review_at`

### Phase transition rules

Keep deterministic phase application, but let Kimi recommend transitions.

Examples:
- `discovery -> alignment` when the chief sees a stable goal + stakeholders
- `alignment -> planning` when constraints and next actions exist
- `planning -> execution` when tasks/commitments are active
- `execution -> waiting` when blocked on external response
- `execution -> verification` when work appears complete but needs confirmation
- `verification -> closed` when success criteria are satisfied

## World Model V1

### File
- Create: `/Users/muhammadali/AxariV2/src/lib/intelligence/world-model.ts`

### Structure

`operational_memory`
- at-risk commitments
- blocked steps
- stale decisions
- urgent pending items

`narrative_memory`
- relationship/account snapshots
- “what changed”
- “what remains true”
- unresolved tensions

`execution_memory`
- active initiatives
- current phase per initiative
- next milestone
- next review
- rationale for current phase

### Update policy

The world model is updated after `ACT`, not before.
Each hourly run reads the current model, reasons, applies changes, then writes the new model.

## Hourly Loop V3 Phases

### 1. Refresh World State
- ingest fresh source artifact deltas
- refresh linked claims / commitments / decision threads
- mark affected initiatives

### 2. Load Scoped Initiative Context
- changed initiatives
- due-for-review initiatives
- top strategic initiatives
- associated vault docs + manual sections

### 3. Sensemaking Pass

Use Kimi to answer:
- what changed?
- what remains true?
- what is probably noise?
- which initiative(s) does this affect?
- is there a contradiction or state shift?

### 4. Execution Pass

Use Kimi to answer:
- what should advance now?
- what should wait?
- what needs escalation?
- what should be written to initiative state / world model / narratives?

### 5. Apply
- deterministic application to initiatives
- commitments / decision thread / claim changes
- outcome and step execution
- notifications / escalations

### 6. Selective Vault Regeneration
- regenerate only docs linked to changed initiatives/entities/artifacts
- do not full-rebuild every run

## Prompt and Agent Changes

### Files
- Modify: [/Users/muhammadali/AxariV2/src/lib/agent/openai/chief-analyst-agent.ts](/Users/muhammadali/AxariV2/src/lib/agent/openai/chief-analyst-agent.ts)
- Modify: [/Users/muhammadali/AxariV2/src/lib/agent/openai/chief-sub-agents.ts](/Users/muhammadali/AxariV2/src/lib/agent/openai/chief-sub-agents.ts)

### Additions to `ChiefAnalystInput`
- `activeClaims`
- `activeCommitments`
- `decisionThreads`
- `activeNarratives`
- `recentSourceArtifacts`
- `initiativeContext`
- `chiefWorldModel`
- `vaultDocs`
- `vaultManualNotes`

### Sub-agent refactor

Recommended structure:
- `sensemaking specialist`
- `initiative planner`
- `execution planner`
- `memory/vault writer`

The current `triage / analysis / execution / graph` model can be evolved rather than replaced.

## Vault As Chief Input

### Files
- Modify: [/Users/muhammadali/AxariV2/src/lib/evidence/context-pack.ts](/Users/muhammadali/AxariV2/src/lib/evidence/context-pack.ts)
- Modify: [/Users/muhammadali/AxariV2/src/lib/evidence/store.ts](/Users/muhammadali/AxariV2/src/lib/evidence/store.ts)
- Modify: [/Users/muhammadali/AxariV2/src/lib/evidence/vault-author.ts](/Users/muhammadali/AxariV2/src/lib/evidence/vault-author.ts)

For each initiative/account scope, load:
- latest narrative doc
- latest relationship/account doc
- linked meetings
- linked commitments
- linked decision threads
- changed claims since last review
- manual sections from vault docs

This turns the vault into a chief-readable planning surface rather than only a UI projection.

## UI Implications

### Files
- Modify: [/Users/muhammadali/AxariV2/src/components/intelligence/intelligence-workspace.tsx](/Users/muhammadali/AxariV2/src/components/intelligence/intelligence-workspace.tsx)
- Modify: [/Users/muhammadali/AxariV2/src/app/api/vault/tree/route.ts](/Users/muhammadali/AxariV2/src/app/api/vault/tree/route.ts)
- Modify: [/Users/muhammadali/AxariV2/src/app/api/vault/document/route.ts](/Users/muhammadali/AxariV2/src/app/api/vault/document/route.ts)

New surfaces:
- `Initiatives` as a first-class left-rail section
- per-initiative “Current phase / Next milestone / Open questions / Latest evidence”
- “Changed since last review” sections surfaced explicitly

## Implementation Tasks

### Task 1: Add schema for initiatives and chief world model

**Files**
- Create: `/Users/muhammadali/AxariV2/supabase/migrations/029_chief_loop_v3_world_model.sql`
- Modify generated DB types after migration if your workflow requires it

**Steps**
1. Write migration adding `initiatives` and `chief_world_model`.
2. Add indexes and RLS policies matching existing service-role + org-read patterns.
3. Add triggers for `updated_at`.
4. Validate migration on local/prod Supabase.

**Tests**
- Add migration verification query coverage in integration/dev notes.

### Task 2: Add pure initiative and focus/world-model helpers

**Files**
- Create: `/Users/muhammadali/AxariV2/src/lib/intelligence/initiative-state.ts`
- Create: `/Users/muhammadali/AxariV2/src/lib/intelligence/world-model.ts`
- Test: `/Users/muhammadali/AxariV2/src/lib/intelligence/initiative-state.test.ts`
- Test: `/Users/muhammadali/AxariV2/src/lib/intelligence/world-model.test.ts`

**Steps**
1. Write failing tests for initiative matching, phase transitions, and scoped initiative selection.
2. Implement minimal pure helpers.
3. Add no-op filtering rules so tiny changes do not churn initiatives.

### Task 3: Upgrade `phaseGather` to Gather V2

**Files**
- Modify: [/Users/muhammadali/AxariV2/src/lib/intelligence/chief-loop.ts](/Users/muhammadali/AxariV2/src/lib/intelligence/chief-loop.ts)
- Modify: `/Users/muhammadali/AxariV2/src/lib/intelligence/chief-world-model.ts`
- Test: `/Users/muhammadali/AxariV2/src/lib/intelligence/chief-loop-gather.test.ts`

**Steps**
1. Extend `GatherResult` with evidence/vault/initiative buckets.
2. Fetch changed claims, commitments, decision threads, source artifacts, and narratives.
3. Fetch initiative candidates and world model.
4. Scope down to affected initiatives + top strategic initiatives.
5. Verify chief input size remains bounded.

### Task 4: Refactor think phase into initiative-scoped reasoning

**Files**
- Modify: [/Users/muhammadali/AxariV2/src/lib/intelligence/chief-loop.ts](/Users/muhammadali/AxariV2/src/lib/intelligence/chief-loop.ts)
- Modify: [/Users/muhammadali/AxariV2/src/lib/agent/openai/chief-analyst-agent.ts](/Users/muhammadali/AxariV2/src/lib/agent/openai/chief-analyst-agent.ts)
- Modify: [/Users/muhammadali/AxariV2/src/lib/agent/openai/chief-sub-agents.ts](/Users/muhammadali/AxariV2/src/lib/agent/openai/chief-sub-agents.ts)
- Test: `/Users/muhammadali/AxariV2/src/lib/agent/openai/chief-initiative-prompt.test.ts`

**Steps**
1. Add initiative/world-model fields to `ChiefAnalystInput`.
2. Add a sensemaking pass prompt and an execution pass prompt.
3. Ensure Kimi sees only scoped initiative context, not whole-org dumps.
4. Preserve fallback behavior to existing monolithic flow until stable.

### Task 5: Apply initiative and world-model updates in `ACT` / `CLOSEOUT`

**Files**
- Modify: [/Users/muhammadali/AxariV2/src/lib/intelligence/chief-loop.ts](/Users/muhammadali/AxariV2/src/lib/intelligence/chief-loop.ts)
- Modify: `/Users/muhammadali/AxariV2/src/lib/intelligence/initiative-state.ts`
- Modify: `/Users/muhammadali/AxariV2/src/lib/intelligence/world-model.ts`
- Test: `/Users/muhammadali/AxariV2/src/lib/intelligence/chief-world-model.test.ts`

**Steps**
1. Add deterministic application for initiative updates.
2. Write new world model after actions are applied.
3. Keep `working_memory` but treat it as compact scratch state.
4. Log initiative changes in chief loop events for auditability.

### Task 6: Make vault input and selective regeneration initiative-aware

**Files**
- Modify: [/Users/muhammadali/AxariV2/src/lib/evidence/store.ts](/Users/muhammadali/AxariV2/src/lib/evidence/store.ts)
- Modify: [/Users/muhammadali/AxariV2/src/lib/evidence/vault-author.ts](/Users/muhammadali/AxariV2/src/lib/evidence/vault-author.ts)
- Modify: [/Users/muhammadali/AxariV2/src/app/api/vault/document/route.ts](/Users/muhammadali/AxariV2/src/app/api/vault/document/route.ts)
- Test: `/Users/muhammadali/AxariV2/src/lib/evidence/vault-initiative-context.test.ts`

**Steps**
1. Hydrate vault manual sections and changed summaries into initiative context.
2. Add initiative-linked vault docs.
3. Regenerate only docs affected by initiative/entity/artifact changes.

### Task 7: UI surface for initiatives

**Files**
- Modify: [/Users/muhammadali/AxariV2/src/components/intelligence/intelligence-workspace.tsx](/Users/muhammadali/AxariV2/src/components/intelligence/intelligence-workspace.tsx)
- Modify: [/Users/muhammadali/AxariV2/src/lib/evidence/intelligence-ui.ts](/Users/muhammadali/AxariV2/src/lib/evidence/intelligence-ui.ts)
- Test: `/Users/muhammadali/AxariV2/src/lib/evidence/intelligence-ui.test.ts`

**Steps**
1. Add `Initiatives` entry points.
2. Show phase, next milestone, and latest state.
3. Add “changed since last review” callout.

## Testing Strategy

Required tests:
- initiative matching and phase transition tests
- gather scoping tests
- prompt contract tests for sensemaking/execution scoped input
- world model write/read tests
- selective vault regeneration tests
- end-to-end scenario:
  - meeting changes Crane relationship
  - initiative state updates
  - chief loop advances next action
  - vault narrative changes

## Rollout Strategy

1. Add schema behind a feature flag, for example `chief_world_model_v3`.
2. Write world model and initiatives in shadow mode first.
3. Keep existing chief decisions running while logging the new scoped initiative reasoning.
4. Compare:
   - number of irrelevant outcomes created
   - repeated Axari-like noise resurfacing
   - continuity of Crane/client work across runs
5. Only then switch `phaseThink` primary path to initiative-scoped reasoning.

## Risks

- Prompt bloat if initiative scoping is not strict.
- Duplicate initiative creation if matching heuristics are weak.
- Vault churn if regeneration thresholds are too sensitive.
- Confusion if `working_memory` and `chief_world_model` overlap ambiguously.

Mitigations:
- bounded initiative selection
- deterministic initiative matching keys + review logging
- explicit separation:
  - `working_memory` = short-horizon scratch state
  - `chief_world_model` = durable org world model

## Success Criteria

This plan is successful when:
- the chief loop reasons over initiatives, not just recent signals
- the vault becomes input as well as output
- a multi-week initiative can persist with phase, risks, questions, and next milestone
- the chief advances long-horizon work across runs without reconstructing everything from scratch
- irrelevant background projects stop dominating chief attention

