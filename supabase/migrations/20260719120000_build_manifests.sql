create table public.build_manifests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  redesign_brief_id uuid not null references public.redesign_briefs on delete restrict,
  research_packet_id uuid not null references public.research_packets on delete restrict,
  crawl_run_id uuid not null references public.crawl_runs on delete restrict,
  schema_version integer not null check (schema_version > 0),
  builder_contract_version text not null check (char_length(trim(builder_contract_version)) > 0),
  status text not null default 'ready' check (status = 'ready'),
  data jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (redesign_brief_id)
);

create index build_manifests_business_generated_idx
  on public.build_manifests (business_id, generated_at desc);

alter table public.build_manifests enable row level security;

create policy "Members can manage build manifests" on public.build_manifests
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create or replace function public.validate_build_manifest_source()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  brief public.redesign_briefs;
begin
  select * into brief
  from public.redesign_briefs
  where id = new.redesign_brief_id;

  if not found
    or brief.status <> 'approved'
    or brief.organization_id <> new.organization_id
    or brief.business_id <> new.business_id
    or brief.research_packet_id <> new.research_packet_id
    or brief.crawl_run_id <> new.crawl_run_id then
    raise exception 'A Build Manifest must be created from its matching approved redesign brief.';
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'Build Manifests are immutable. Approve a new redesign brief to create a new manifest.';
  end if;

  return new;
end;
$$;

create trigger validate_build_manifest_source
  before insert or update on public.build_manifests
  for each row execute procedure public.validate_build_manifest_source();

create trigger set_build_manifests_updated_at before update on public.build_manifests
  for each row execute procedure public.set_updated_at();
