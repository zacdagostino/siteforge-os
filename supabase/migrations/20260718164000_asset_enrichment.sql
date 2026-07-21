create table public.asset_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  crawl_run_id uuid not null references public.crawl_runs on delete cascade unique,
  status public.job_status not null default 'queued',
  model text,
  worker_id text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.asset_annotations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  crawl_run_id uuid not null references public.crawl_runs on delete cascade,
  asset_id uuid not null references public.artifacts on delete cascade unique,
  analysis_job_id uuid references public.asset_analysis_jobs on delete set null,
  source_context jsonb not null default '{}'::jsonb,
  observed_description text not null default '',
  visible_text text[] not null default '{}',
  suggested_role text not null default 'unknown'
    check (suggested_role in ('primary_logo', 'secondary_mark', 'worksite_photo', 'team_photo', 'project_photo', 'partner_logo', 'supplier_logo', 'decorative', 'unknown', 'exclude')),
  business_association text not null default 'unknown'
    check (business_association in ('target_business', 'third_party', 'unknown')),
  safe_reuse_note text not null default '',
  cautions text[] not null default '{}',
  confidence text not null default 'low' check (confidence in ('high', 'medium', 'low')),
  review_state public.review_state not null default 'needs_review',
  human_notes text not null default '',
  model text,
  model_output jsonb not null default '{}'::jsonb,
  analyzed_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index asset_analysis_jobs_business_idx
  on public.asset_analysis_jobs (business_id, created_at desc);
create index asset_annotations_run_idx
  on public.asset_annotations (crawl_run_id, created_at);

alter table public.asset_analysis_jobs enable row level security;
alter table public.asset_annotations enable row level security;

create policy "Members can manage asset analysis jobs" on public.asset_analysis_jobs
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create policy "Members can manage asset annotations" on public.asset_annotations
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create trigger set_asset_analysis_jobs_updated_at before update on public.asset_analysis_jobs
  for each row execute procedure public.set_updated_at();
create trigger set_asset_annotations_updated_at before update on public.asset_annotations
  for each row execute procedure public.set_updated_at();

create or replace function public.request_asset_analysis(target_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
  latest_capture_id uuid;
  existing_job public.asset_analysis_jobs;
  requested_job_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  select organization_id into target_organization_id
  from public.businesses where id = target_business_id;
  if target_organization_id is null
    or not public.is_organization_member(target_organization_id) then
    raise exception 'Organization membership is required.';
  end if;

  select runs.id into latest_capture_id
  from public.crawl_runs runs
  join public.websites websites on websites.id = runs.website_id
  where websites.business_id = target_business_id
    and runs.status = 'ready'
  order by runs.completed_at desc nulls last, runs.requested_at desc
  limit 1;
  if latest_capture_id is null then
    raise exception 'A completed website capture is required before assets can be analysed.';
  end if;

  select * into existing_job from public.asset_analysis_jobs
  where crawl_run_id = latest_capture_id;
  if existing_job.id is not null and existing_job.status in ('queued', 'running') then
    return existing_job.id;
  end if;

  insert into public.asset_analysis_jobs (organization_id, business_id, crawl_run_id, status)
  values (target_organization_id, target_business_id, latest_capture_id, 'queued')
  on conflict (crawl_run_id) do update set
    status = 'queued', worker_id = null, lease_expires_at = null, error_summary = null
  returning id into requested_job_id;

  insert into public.activities (organization_id, business_id, type, message)
  values (target_organization_id, target_business_id, 'note',
    'Private visual-asset analysis requested. Suggestions require human review before reuse.');
  return requested_job_id;
end;
$$;

grant execute on function public.request_asset_analysis(uuid) to authenticated;

create or replace function public.claim_next_asset_analysis(worker_identity text)
returns setof public.asset_analysis_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'A service-role worker is required.';
  end if;
  return query
  with candidate as (
    select id from public.asset_analysis_jobs
    where (status = 'queued' or (status = 'running' and lease_expires_at < now()))
      and attempt_count < 3
    order by created_at for update skip locked limit 1
  )
  update public.asset_analysis_jobs jobs set
    status = 'running', worker_id = trim(worker_identity),
    lease_expires_at = now() + interval '20 minutes',
    attempt_count = jobs.attempt_count + 1, error_summary = null
  from candidate where jobs.id = candidate.id returning jobs.*;
end;
$$;

revoke all on function public.claim_next_asset_analysis(text) from public, anon, authenticated;
grant execute on function public.claim_next_asset_analysis(text) to service_role;
