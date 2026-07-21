alter table public.crawl_runs
  add column if not exists progress_phase text not null default 'queued',
  add column if not exists progress_detail text,
  add column if not exists current_url text,
  add column if not exists cancel_requested_at timestamptz;

create or replace function public.cancel_website_capture(target_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
  target_website_id uuid;
  target_run public.crawl_runs;
  cancellation_time timestamptz := now();
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

  select id into target_website_id
  from public.websites
  where business_id = target_business_id
    and organization_id = target_organization_id
  order by created_at
  limit 1;

  select * into target_run
  from public.crawl_runs
  where website_id = target_website_id
    and status in ('queued', 'running')
  order by requested_at desc
  limit 1
  for update;

  if target_run.id is null then
    raise exception 'There is no active website capture to cancel.';
  end if;

  update public.crawl_runs
  set
    status = case when target_run.status = 'queued' then 'failed' else status end,
    completed_at = case when target_run.status = 'queued' then cancellation_time else completed_at end,
    lease_expires_at = case when target_run.status = 'queued' then null else lease_expires_at end,
    cancel_requested_at = cancellation_time,
    progress_phase = 'cancelled',
    progress_detail = 'Cancellation requested. The worker will stop after its current safe capture step.',
    error_summary = 'Capture cancelled by a workspace user.'
  where id = target_run.id;

  update public.websites
  set crawl_status = 'not_started'
  where id = target_website_id;

  insert into public.activities (organization_id, business_id, type, message)
  values (
    target_organization_id,
    target_business_id,
    'note',
    'Website capture cancellation requested. Any page evidence already saved remains private and is marked as partial.'
  );

  return target_run.id;
end;
$$;

grant execute on function public.cancel_website_capture(uuid) to authenticated;

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
    error_summary = 'Capture worker lease expired after repeated attempts.'
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
    current_url = runs.target_url,
    error_summary = null
  from candidate
  where runs.id = candidate.id
  returning runs.*;
end;
$$;
