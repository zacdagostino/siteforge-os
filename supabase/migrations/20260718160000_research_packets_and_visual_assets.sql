alter table public.artifacts
  drop constraint if exists artifacts_kind_check;

alter table public.artifacts
  add constraint artifacts_kind_check
  check (kind in ('html', 'screenshot', 'content', 'performance', 'accessibility', 'asset', 'report', 'preview'));

update storage.buckets
set allowed_mime_types = array[
  'text/html',
  'application/json',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml'
]
where id = 'siteforge-artifacts';

create table public.research_packets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  crawl_run_id uuid not null references public.crawl_runs on delete cascade unique,
  schema_version integer not null default 1 check (schema_version > 0),
  data jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index research_packets_business_idx
  on public.research_packets (business_id, generated_at desc);

alter table public.research_packets enable row level security;

create policy "Members can manage research packets" on public.research_packets
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
