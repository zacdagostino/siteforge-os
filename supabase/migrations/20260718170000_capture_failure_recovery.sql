alter table public.crawl_runs
  add column if not exists resume_queue jsonb not null default '[]'::jsonb,
  add column if not exists failure_phase text,
  add column if not exists failure_url text,
  add column if not exists failure_detail text;

create or replace function public.continue_website_capture(target_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
  target_website_id uuid;
  target_run public.crawl_runs;
  resume_url text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  select organization_id into target_organization_id
  from public.businesses
  where id = target_business_id;
  if target_organization_id is null
    or not public.is_organization_member(target_organization_id) then
    raise exception 'Organization membership is required.';
  end if;

  select id into target_website_id
  from public.websites
  where business_id = target_business_id
    and organization_id = target_organization_id
  order by created_at
  limit 1;

  select * into target_run
  from public.crawl_runs
  where website_id = target_website_id
    and status = 'failed'
    and cancel_requested_at is null
  order by requested_at desc
  limit 1
  for update;

  if target_run.id is null then
    raise exception 'There is no failed website capture to continue.';
  end if;

  resume_url := coalesce(target_run.failure_url, target_run.current_url, target_run.target_url);

  update public.crawl_runs
  set
    status = 'queued',
    requested_at = now(),
    started_at = null,
    completed_at = null,
    worker_id = null,
    lease_expires_at = null,
    attempt_count = 0,
    progress_phase = 'queued',
    progress_detail = 'Continuation requested. The worker will resume from the last incomplete capture step.',
    current_url = resume_url,
    resume_queue = case
      when jsonb_typeof(target_run.resume_queue) = 'array'
        and jsonb_array_length(target_run.resume_queue) > 0 then target_run.resume_queue
      else jsonb_build_array(resume_url)
    end,
    error_summary = null,
    failure_phase = null,
    failure_url = null,
    failure_detail = null
  where id = target_run.id;

  update public.websites
  set crawl_status = 'queued'
  where id = target_website_id;

  insert into public.activities (organization_id, business_id, type, message)
  values (
    target_organization_id,
    target_business_id,
    'research_requested',
    'Website capture continuation requested. Existing private evidence will be retained and the worker will retry the incomplete step.'
  );

  return target_run.id;
end;
$$;

grant execute on function public.continue_website_capture(uuid) to authenticated;

create or replace function public.claim_next_homepage_capture(worker_identity text)
returns setof public.crawl_runs
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'A service-role worker is required.';
  end if;

  if char_length(trim(worker_identity)) = 0 or char_length(worker_identity) > 120 then
    raise exception 'A valid worker identity is required.';
  end if;

  update public.crawl_runs
  set
    status = 'failed',
    completed_at = now(),
    lease_expires_at = null,
    progress_phase = 'cancelled',
    progress_detail = 'Capture cancelled before a worker could safely stop.',
    error_summary = 'Capture cancelled by a workspace user.'
  where status = 'running'
    and cancel_requested_at is not null;

  update public.crawl_runs
  set
    status = 'failed',
    completed_at = now(),
    lease_expires_at = null,
    progress_phase = 'failed',
    progress_detail = 'Capture worker lease expired after repeated attempts.',
    error_summary = 'Capture worker lease expired after repeated attempts.',
    failure_phase = coalesce(progress_phase, 'capturing_page'),
    failure_url = current_url,
    failure_detail = 'The worker lease expired before the current capture step completed.'
  where status = 'running'
    and cancel_requested_at is null
    and lease_expires_at < now()
    and attempt_count >= 3;

  return query
  with candidate as (
    select id
    from public.crawl_runs
    where (
      status = 'queued'
      or (status = 'running' and lease_expires_at < now())
    )
      and cancel_requested_at is null
      and attempt_count < 3
    order by requested_at
    for update skip locked
    limit 1
  )
  update public.crawl_runs as runs
  set
    status = 'running',
    started_at = now(),
    worker_id = trim(worker_identity),
    lease_expires_at = now() + interval '45 minutes',
    attempt_count = runs.attempt_count + 1,
    progress_phase = 'discovering',
    progress_detail = 'Protected capture worker started.',
    current_url = coalesce(runs.resume_queue ->> 0, runs.target_url),
    error_summary = null
  from candidate
  where runs.id = candidate.id
  returning runs.*;
end;
$$;
