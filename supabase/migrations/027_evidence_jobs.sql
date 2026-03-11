create table if not exists public.evidence_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_kind text not null check (source_kind in ('meeting', 'slack', 'email', 'chat')),
  current_stage text not null check (current_stage in ('ingest', 'analyze', 'finalize')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  payload jsonb not null,
  compatibility jsonb not null default '{}'::jsonb,
  source_summary jsonb,
  analyst_bundle jsonb,
  artifact_id uuid references public.source_artifacts(id) on delete set null,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  last_error text,
  stage_metrics jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_evidence_jobs_status_stage_created
  on public.evidence_jobs(status, current_stage, created_at);

create index if not exists idx_evidence_jobs_org_created
  on public.evidence_jobs(org_id, created_at desc);

create index if not exists idx_evidence_jobs_artifact
  on public.evidence_jobs(artifact_id);

alter table public.evidence_jobs enable row level security;

create policy "Org members can view evidence jobs"
  on public.evidence_jobs
  for select
  using (org_id = public.user_org_id());

create policy "Service role can manage evidence jobs"
  on public.evidence_jobs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
