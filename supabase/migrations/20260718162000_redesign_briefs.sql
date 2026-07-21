create table public.redesign_briefs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  research_packet_id uuid not null references public.research_packets on delete restrict,
  crawl_run_id uuid not null references public.crawl_runs on delete restrict,
  status text not null default 'draft' check (status in ('draft', 'approved')),
  version integer not null default 1 check (version > 0),
  source_selections jsonb not null default '{"pageUrls": [], "assetIds": [], "uncertainties": []}'::jsonb,
  draft jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, version)
);

create index redesign_briefs_business_idx
  on public.redesign_briefs (business_id, version desc);

alter table public.redesign_briefs enable row level security;

create policy "Members can manage redesign briefs" on public.redesign_briefs
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create trigger set_redesign_briefs_updated_at before update on public.redesign_briefs
  for each row execute procedure public.set_updated_at();
