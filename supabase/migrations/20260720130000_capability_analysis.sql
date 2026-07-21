create table public.capability_analysis_jobs (
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
  progress_phase text not null default 'queued',
  progress_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index capability_analysis_jobs_business_idx
  on public.capability_analysis_jobs (business_id, created_at desc);

alter table public.capability_analysis_jobs enable row level security;

create policy "Members can manage capability analysis jobs" on public.capability_analysis_jobs
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create trigger set_capability_analysis_jobs_updated_at before update on public.capability_analysis_jobs
  for each row execute procedure public.set_updated_at();

create or replace function public.request_capability_analysis(target_business_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare target_organization_id uuid; latest_capture_id uuid; requested_job_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required.'; end if;
  select organization_id into target_organization_id from public.businesses where id = target_business_id;
  if target_organization_id is null or not public.is_organization_member(target_organization_id) then
    raise exception 'Organization membership is required.';
  end if;
  select runs.id into latest_capture_id from public.crawl_runs runs
    join public.websites websites on websites.id = runs.website_id
    where websites.business_id = target_business_id and runs.status = 'ready'
    order by runs.completed_at desc nulls last, runs.requested_at desc limit 1;
  if latest_capture_id is null then raise exception 'A completed website capture is required.'; end if;
  insert into public.capability_analysis_jobs (organization_id, business_id, crawl_run_id, status)
  values (target_organization_id, target_business_id, latest_capture_id, 'queued')
  on conflict (crawl_run_id) do update set status = 'queued', worker_id = null,
    lease_expires_at = null, attempt_count = 0, error_summary = null,
    progress_phase = 'queued', progress_detail = 'AI capability analysis requested from saved capture evidence.'
  returning id into requested_job_id;
  return requested_job_id;
end; $$;

create or replace function public.claim_next_capability_analysis(worker_identity text)
returns setof public.capability_analysis_jobs
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'A service-role worker is required.'; end if;
  return query with candidate as (
    select id from public.capability_analysis_jobs
    where (status = 'queued' or (status = 'running' and lease_expires_at < now()))
      and attempt_count < 3
    order by created_at for update skip locked limit 1
  ) update public.capability_analysis_jobs jobs set
    status = 'running', worker_id = trim(worker_identity), lease_expires_at = now() + interval '10 minutes',
    attempt_count = jobs.attempt_count + 1, progress_phase = 'reading_capture',
    progress_detail = 'Loading the completed private website capture for AI capability interpretation.',
    error_summary = null
  from candidate where jobs.id = candidate.id returning jobs.*;
end; $$;

revoke all on function public.claim_next_capability_analysis(text) from public, anon, authenticated;
grant execute on function public.claim_next_capability_analysis(text) to service_role;
grant execute on function public.request_capability_analysis(uuid) to authenticated;
