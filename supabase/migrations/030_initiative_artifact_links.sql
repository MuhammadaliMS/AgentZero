-- Migration 030: Persist source artifact impact on initiatives

create table if not exists public.initiative_artifact_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  initiative_id uuid not null references public.initiatives(id) on delete cascade,
  artifact_id uuid not null references public.source_artifacts(id) on delete cascade,
  link_reason text not null default 'signal'
    check (link_reason in ('claim', 'signal', 'claim+signal')),
  link_source text not null default 'chief_loop',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, initiative_id, artifact_id)
);

create index if not exists idx_initiative_artifact_links_org_artifact
  on public.initiative_artifact_links (org_id, artifact_id, updated_at desc);

create index if not exists idx_initiative_artifact_links_org_initiative
  on public.initiative_artifact_links (org_id, initiative_id, updated_at desc);

create or replace function public.update_initiative_artifact_links_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_initiative_artifact_links_updated_at on public.initiative_artifact_links;
create trigger trg_initiative_artifact_links_updated_at
  before update on public.initiative_artifact_links
  for each row
  execute function public.update_initiative_artifact_links_updated_at();

alter table public.initiative_artifact_links enable row level security;

drop policy if exists "Org members can view initiative artifact links" on public.initiative_artifact_links;
create policy "Org members can view initiative artifact links"
  on public.initiative_artifact_links for select using (org_id = public.user_org_id());

drop policy if exists "Service role full access initiative artifact links" on public.initiative_artifact_links;
create policy "Service role full access initiative artifact links"
  on public.initiative_artifact_links for all using (auth.role() = 'service_role');
