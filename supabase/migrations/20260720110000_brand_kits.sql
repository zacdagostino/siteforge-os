create table public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  crawl_run_id uuid not null references public.crawl_runs on delete restrict,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'approved')),
  primary_logo_artifact_id uuid references public.artifacts on delete restrict,
  approved_asset_ids uuid[] not null default '{}',
  palette jsonb not null default '{}'::jsonb,
  notes text not null default '',
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, version)
);

create index brand_kits_business_version_idx
  on public.brand_kits (business_id, version desc);

alter table public.brand_kits enable row level security;

create policy "Members can manage brand kits" on public.brand_kits
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create trigger set_brand_kits_updated_at before update on public.brand_kits
  for each row execute procedure public.set_updated_at();

create or replace function public.require_brand_kit_for_builder_run()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  manifest_data jsonb;
begin
  select data into manifest_data
  from public.build_manifests
  where id = new.build_manifest_id;

  if coalesce(manifest_data #>> '{brandKit,id}', '') = ''
    or coalesce(manifest_data #>> '{brandKit,primaryLogoAssetId}', '') = '' then
    raise exception 'An approved Brand Kit is required before a private website build can be requested.';
  end if;
  return new;
end;
$$;

create trigger require_brand_kit_for_builder_run
  before insert on public.builder_runs
  for each row execute procedure public.require_brand_kit_for_builder_run();
