-- Migration 028: Vault V2 sectioned documents + separated vault writing stage

alter table public.vault_documents
  add column if not exists render_strategy text not null default 'deterministic',
  add column if not exists sections jsonb not null default '[]'::jsonb,
  add column if not exists manual_sections jsonb not null default '{}'::jsonb,
  add column if not exists staleness_reason text,
  add column if not exists last_source_update_at timestamptz;

alter table public.vault_document_links
  add column if not exists target_label text,
  add column if not exists target_path text,
  add column if not exists target_type text,
  add column if not exists target_metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_vault_documents_org_updated
  on public.vault_documents (org_id, updated_at desc);

create index if not exists idx_vault_documents_last_source_update
  on public.vault_documents (org_id, last_source_update_at desc nulls last);

create index if not exists idx_vault_document_links_doc_kind
  on public.vault_document_links (vault_document_id, link_kind);

alter table public.vault_documents
  drop constraint if exists vault_documents_document_type_check;

alter table public.vault_documents
  add constraint vault_documents_document_type_check
  check (
    document_type in (
      'source_artifact',
      'entity',
      'commitment',
      'decision_thread',
      'timeline',
      'narrative',
      'brief'
    )
  );

alter table public.vault_documents
  drop constraint if exists vault_documents_render_strategy_check;

alter table public.vault_documents
  add constraint vault_documents_render_strategy_check
  check (render_strategy in ('deterministic', 'llm_assisted', 'kimi_authored'));

update public.vault_documents
set render_strategy = case
  when document_type = 'source_artifact' then 'llm_assisted'
  when document_type in ('entity', 'commitment', 'decision_thread') then 'llm_assisted'
  when document_type = 'timeline' then 'deterministic'
  when document_type in ('narrative', 'brief') then 'kimi_authored'
  else 'deterministic'
end
where render_strategy not in ('deterministic', 'llm_assisted', 'kimi_authored');

alter table public.evidence_jobs
  add column if not exists applied_summary jsonb;

alter table public.evidence_jobs
  drop constraint if exists evidence_jobs_current_stage_check;

alter table public.evidence_jobs
  add constraint evidence_jobs_current_stage_check
  check (current_stage in ('ingest', 'analyze', 'finalize', 'write_vault'));
