create extension if not exists pgcrypto;

create type public.member_role as enum ('owner', 'admin', 'member');
create type public.business_kind as enum ('prospect', 'client');
create type public.prospect_stage as enum (
  'identified',
  'researching',
  'audit_ready',
  'concept_ready',
  'awaiting_approval',
  'outreach_pending',
  'responded',
  'proposal',
  'won',
  'lost',
  'paused'
);
create type public.review_state as enum ('needs_review', 'approved', 'blocked');
create type public.evidence_state as enum ('not_collected', 'inferred', 'verified', 'rejected');
create type public.task_state as enum ('open', 'done');
create type public.job_status as enum ('not_started', 'queued', 'running', 'ready', 'failed');
create type public.deliverable_status as enum ('not_started', 'draft', 'ready', 'approved');

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  created_by uuid not null references auth.users on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role public.member_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  kind public.business_kind not null default 'prospect',
  name text not null check (char_length(trim(name)) between 1 and 240),
  stage public.prospect_stage not null default 'identified',
  review_state public.review_state not null default 'needs_review',
  opportunity_score smallint check (opportunity_score between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.websites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  url text not null,
  domain text not null,
  crawl_status public.job_status not null default 'not_started',
  last_captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, url)
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  name text,
  role text,
  email text,
  phone text,
  verification_state public.evidence_state not null default 'not_collected',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.crawl_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  website_id uuid not null references public.websites on delete cascade,
  status public.job_status not null default 'not_started',
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  discovered_page_count integer not null default 0 check (discovered_page_count >= 0),
  captured_page_count integer not null default 0 check (captured_page_count >= 0),
  failed_page_count integer not null default 0 check (failed_page_count >= 0),
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.crawl_pages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  crawl_run_id uuid not null references public.crawl_runs on delete cascade,
  url text not null,
  canonical_url text,
  title text,
  status_code integer check (status_code between 100 and 599),
  content_hash text,
  capture_status public.job_status not null default 'not_started',
  created_at timestamptz not null default now(),
  unique (crawl_run_id, url)
);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  crawl_run_id uuid references public.crawl_runs on delete set null,
  kind text not null check (kind in ('html', 'screenshot', 'performance', 'accessibility', 'report', 'preview')),
  storage_bucket text not null default 'siteforge-artifacts',
  storage_path text not null unique,
  content_type text,
  byte_size bigint check (byte_size >= 0),
  sha256 text,
  created_at timestamptz not null default now()
);

create table public.evidence_facts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  label text not null,
  value text not null,
  source_url text,
  evidence text not null,
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  verification_state public.evidence_state not null default 'not_collected',
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  crawl_run_id uuid references public.crawl_runs on delete set null,
  status public.job_status not null default 'not_started',
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, version)
);

create table public.audit_findings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  audit_id uuid not null references public.audits on delete cascade,
  area text not null check (area in ('UI', 'UX', 'Mobile', 'Accessibility', 'SEO', 'Performance', 'Content', 'Trust', 'Conversion')),
  severity text not null check (severity in ('high', 'medium', 'low')),
  title text not null,
  finding text not null,
  recommendation text not null,
  evidence_fact_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.redesign_concepts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  audit_id uuid references public.audits on delete set null,
  status public.deliverable_status not null default 'not_started',
  version integer not null default 1 check (version > 0),
  summary text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, version)
);

create table public.decision_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  concept_id uuid references public.redesign_concepts on delete set null,
  status public.deliverable_status not null default 'not_started',
  version integer not null default 1 check (version > 0),
  summary text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, version)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  body text not null,
  due_at timestamptz,
  state public.task_state not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  type text not null check (type in ('created', 'research_requested', 'approved', 'task_completed', 'note')),
  message text not null,
  created_at timestamptz not null default now()
);

create index businesses_organization_updated_idx on public.businesses (organization_id, updated_at desc);
create index websites_business_idx on public.websites (business_id);
create index contacts_business_idx on public.contacts (business_id);
create index crawl_runs_website_idx on public.crawl_runs (website_id, requested_at desc);
create index crawl_pages_run_idx on public.crawl_pages (crawl_run_id);
create index artifacts_business_idx on public.artifacts (business_id, created_at desc);
create index evidence_facts_business_idx on public.evidence_facts (business_id, captured_at desc);
create index audits_business_idx on public.audits (business_id, version desc);
create index concepts_business_idx on public.redesign_concepts (business_id, version desc);
create index reports_business_idx on public.decision_reports (business_id, version desc);
create index tasks_business_state_idx on public.tasks (business_id, state, due_at);
create index activities_business_idx on public.activities (business_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', new.email));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

insert into public.profiles (id, display_name)
select id, coalesce(raw_user_meta_data ->> 'name', email)
from auth.users
on conflict (id) do nothing;

create or replace function public.is_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members
    where organization_id = target_organization_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.create_organization(organization_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_organization_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  insert into public.organizations (id, name, created_by)
  values (new_organization_id, trim(organization_name), auth.uid());

  insert into public.organization_members (organization_id, user_id, role)
  values (new_organization_id, auth.uid(), 'owner');

  return new_organization_id;
end;
$$;

grant execute on function public.create_organization(text) to authenticated;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.businesses enable row level security;
alter table public.websites enable row level security;
alter table public.contacts enable row level security;
alter table public.crawl_runs enable row level security;
alter table public.crawl_pages enable row level security;
alter table public.artifacts enable row level security;
alter table public.evidence_facts enable row level security;
alter table public.audits enable row level security;
alter table public.audit_findings enable row level security;
alter table public.redesign_concepts enable row level security;
alter table public.decision_reports enable row level security;
alter table public.tasks enable row level security;
alter table public.activities enable row level security;

create policy "Users can read their own profile" on public.profiles
  for select to authenticated using (id = auth.uid());
create policy "Users can update their own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "Members can read organizations" on public.organizations
  for select to authenticated using (public.is_organization_member(id));
create policy "Members can read memberships" on public.organization_members
  for select to authenticated using (public.is_organization_member(organization_id));

create policy "Members can manage businesses" on public.businesses
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage websites" on public.websites
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage contacts" on public.contacts
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage crawl runs" on public.crawl_runs
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage crawl pages" on public.crawl_pages
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage artifact records" on public.artifacts
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage evidence facts" on public.evidence_facts
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage audits" on public.audits
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage audit findings" on public.audit_findings
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage redesign concepts" on public.redesign_concepts
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage decision reports" on public.decision_reports
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage tasks" on public.tasks
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));
create policy "Members can manage activities" on public.activities
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'siteforge-artifacts',
  'siteforge-artifacts',
  false,
  52428800,
  array['text/html', 'application/json', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

create trigger set_profiles_updated_at before update on public.profiles
  for each row execute procedure public.set_updated_at();
create trigger set_organizations_updated_at before update on public.organizations
  for each row execute procedure public.set_updated_at();
create trigger set_businesses_updated_at before update on public.businesses
  for each row execute procedure public.set_updated_at();
create trigger set_websites_updated_at before update on public.websites
  for each row execute procedure public.set_updated_at();
create trigger set_contacts_updated_at before update on public.contacts
  for each row execute procedure public.set_updated_at();
create trigger set_crawl_runs_updated_at before update on public.crawl_runs
  for each row execute procedure public.set_updated_at();
create trigger set_evidence_facts_updated_at before update on public.evidence_facts
  for each row execute procedure public.set_updated_at();
create trigger set_audits_updated_at before update on public.audits
  for each row execute procedure public.set_updated_at();
create trigger set_redesign_concepts_updated_at before update on public.redesign_concepts
  for each row execute procedure public.set_updated_at();
create trigger set_decision_reports_updated_at before update on public.decision_reports
  for each row execute procedure public.set_updated_at();
create trigger set_tasks_updated_at before update on public.tasks
  for each row execute procedure public.set_updated_at();
