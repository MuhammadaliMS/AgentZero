-- Migration 029: Chief Loop V3 world model + initiatives

create table if not exists public.initiatives (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  goal text not null,
  scope text,
  status text not null default 'active'
    check (status in ('active', 'waiting', 'blocked', 'closed', 'archived')),
  phase text not null default 'discovery'
    check (phase in ('discovery', 'alignment', 'planning', 'execution', 'waiting', 'verification', 'closed')),
  success_criteria jsonb not null default '[]'::jsonb,
  current_hypothesis text,
  open_questions jsonb not null default '[]'::jsonb,
  known_risks jsonb not null default '[]'::jsonb,
  dependencies jsonb not null default '[]'::jsonb,
  stakeholders jsonb not null default '[]'::jsonb,
  linked_entity_ids uuid[] not null default '{}',
  linked_claim_ids uuid[] not null default '{}',
  linked_commitment_ids uuid[] not null default '{}',
  linked_decision_thread_ids uuid[] not null default '{}',
  latest_summary text,
  next_milestone text,
  next_review_at timestamptz,
  last_signal_at timestamptz,
  last_reconciled_at timestamptz,
  source text not null default 'chief_loop',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, title)
);

create index if not exists idx_initiatives_org_status
  on public.initiatives (org_id, status, updated_at desc);

create index if not exists idx_initiatives_next_review
  on public.initiatives (org_id, next_review_at asc nulls last);

create index if not exists idx_initiatives_entities
  on public.initiatives using gin (linked_entity_ids);

create index if not exists idx_initiatives_claims
  on public.initiatives using gin (linked_claim_ids);

create index if not exists idx_initiatives_commitments
  on public.initiatives using gin (linked_commitment_ids);

create index if not exists idx_initiatives_decision_threads
  on public.initiatives using gin (linked_decision_thread_ids);

create table if not exists public.chief_world_model (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  operational_memory jsonb not null default '{}'::jsonb,
  narrative_memory jsonb not null default '{}'::jsonb,
  execution_memory jsonb not null default '{}'::jsonb,
  initiative_priorities jsonb not null default '[]'::jsonb,
  changed_since_last_run jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

create index if not exists idx_chief_world_model_updated
  on public.chief_world_model (updated_at desc);

create or replace function public.update_initiatives_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_initiatives_updated_at on public.initiatives;
create trigger trg_initiatives_updated_at
  before update on public.initiatives
  for each row
  execute function public.update_initiatives_updated_at();

create or replace function public.update_chief_world_model_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_chief_world_model_updated_at on public.chief_world_model;
create trigger trg_chief_world_model_updated_at
  before update on public.chief_world_model
  for each row
  execute function public.update_chief_world_model_updated_at();

alter table public.initiatives enable row level security;
alter table public.chief_world_model enable row level security;

drop policy if exists "Org members can view initiatives" on public.initiatives;
create policy "Org members can view initiatives"
  on public.initiatives for select using (org_id = public.user_org_id());

drop policy if exists "Service role full access initiatives" on public.initiatives;
create policy "Service role full access initiatives"
  on public.initiatives for all using (auth.role() = 'service_role');

drop policy if exists "Org members can view chief world model" on public.chief_world_model;
create policy "Org members can view chief world model"
  on public.chief_world_model for select using (org_id = public.user_org_id());

drop policy if exists "Service role full access chief world model" on public.chief_world_model;
create policy "Service role full access chief world model"
  on public.chief_world_model for all using (auth.role() = 'service_role');
