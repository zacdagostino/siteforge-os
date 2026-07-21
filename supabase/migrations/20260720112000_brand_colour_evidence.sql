create table public.brand_colour_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  crawl_run_id uuid not null references public.crawl_runs on delete cascade,
  asset_id uuid references public.artifacts on delete cascade,
  source_type text not null check (source_type in ('logo_vector', 'logo_pixels', 'website_css', 'rendered_ui')),
  source_key text not null,
  source_label text not null,
  source_url text,
  colour text not null check (colour ~ '^#[0-9A-F]{6}$'),
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  confidence text not null default 'medium' check (confidence in ('high', 'medium', 'low')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (crawl_run_id, source_key)
);

create index brand_colour_evidence_run_idx
  on public.brand_colour_evidence (crawl_run_id, source_type, colour);

alter table public.brand_colour_evidence enable row level security;

create policy "Members can read brand colour evidence" on public.brand_colour_evidence
  for select to authenticated
  using (public.is_organization_member(organization_id));

create policy "Members can manage brand colour evidence" on public.brand_colour_evidence
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
