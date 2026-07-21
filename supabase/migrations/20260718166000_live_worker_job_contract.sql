alter table public.asset_analysis_jobs
  add column if not exists progress_phase text not null default 'queued',
  add column if not exists progress_detail text,
  add column if not exists current_asset_id uuid references public.artifacts on delete set null,
  add column if not exists total_items integer not null default 0 check (total_items >= 0),
  add column if not exists completed_items integer not null default 0 check (completed_items >= 0),
  add column if not exists cancel_requested_at timestamptz;

alter table public.audits
  add column if not exists progress_phase text not null default 'queued',
  add column if not exists progress_detail text,
  add column if not exists total_items integer not null default 0 check (total_items >= 0),
  add column if not exists completed_items integer not null default 0 check (completed_items >= 0),
  add column if not exists cancel_requested_at timestamptz;

create or replace function public.cancel_asset_analysis(target_business_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare target_organization_id uuid; target_job public.asset_analysis_jobs; now_at timestamptz := now();
begin
  if auth.uid() is null then raise exception 'Authentication is required.'; end if;
  select organization_id into target_organization_id from public.businesses where id = target_business_id;
  if target_organization_id is null or not public.is_organization_member(target_organization_id) then
    raise exception 'Organization membership is required.';
  end if;
  select * into target_job from public.asset_analysis_jobs
  where business_id = target_business_id and status in ('queued', 'running')
  order by created_at desc limit 1 for update;
  if target_job.id is null then raise exception 'There is no active asset analysis to cancel.'; end if;
  update public.asset_analysis_jobs set
    status = case when target_job.status = 'queued' then 'failed' else status end,
    lease_expires_at = case when target_job.status = 'queued' then null else lease_expires_at end,
    cancel_requested_at = now_at, progress_phase = 'cancelled',
    progress_detail = 'Cancellation requested. The worker will stop after the current image.',
    error_summary = 'Asset analysis cancelled by a workspace user.'
  where id = target_job.id;
  insert into public.activities (organization_id, business_id, type, message)
  values (target_organization_id, target_business_id, 'note', 'Visual-asset analysis cancellation requested. Saved suggestions remain private and editable.');
  return target_job.id;
end; $$;
grant execute on function public.cancel_asset_analysis(uuid) to authenticated;

create or replace function public.cancel_website_audit(target_business_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare target_organization_id uuid; target_audit public.audits; now_at timestamptz := now();
begin
  if auth.uid() is null then raise exception 'Authentication is required.'; end if;
  select organization_id into target_organization_id from public.businesses where id = target_business_id;
  if target_organization_id is null or not public.is_organization_member(target_organization_id) then
    raise exception 'Organization membership is required.';
  end if;
  select * into target_audit from public.audits
  where business_id = target_business_id and status in ('queued', 'running')
  order by version desc limit 1 for update;
  if target_audit.id is null then raise exception 'There is no active website audit to cancel.'; end if;
  update public.audits set
    status = case when target_audit.status = 'queued' then 'failed' else status end,
    worker_id = case when target_audit.status = 'queued' then null else worker_id end,
    lease_expires_at = case when target_audit.status = 'queued' then null else lease_expires_at end,
    cancel_requested_at = now_at, progress_phase = 'cancelled',
    progress_detail = 'Cancellation requested. The worker will stop after its current safe step.',
    error_summary = 'Website audit cancelled by a workspace user.'
  where id = target_audit.id;
  insert into public.activities (organization_id, business_id, type, message)
  values (target_organization_id, target_business_id, 'note', 'Automated audit cancellation requested. Saved findings remain private and require review.');
  return target_audit.id;
end; $$;
grant execute on function public.cancel_website_audit(uuid) to authenticated;

create or replace function public.claim_next_asset_analysis(worker_identity text)
returns setof public.asset_analysis_jobs
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'A service-role worker is required.'; end if;
  update public.asset_analysis_jobs set status = 'failed', lease_expires_at = null,
    progress_phase = 'cancelled', progress_detail = 'Asset analysis cancelled before a worker could safely stop.',
    error_summary = 'Asset analysis cancelled by a workspace user.'
  where status = 'running' and cancel_requested_at is not null;
  return query with candidate as (
    select id from public.asset_analysis_jobs
    where (status = 'queued' or (status = 'running' and lease_expires_at < now()))
      and cancel_requested_at is null and attempt_count < 3
    order by created_at for update skip locked limit 1
  ) update public.asset_analysis_jobs jobs set
    status = 'running', worker_id = trim(worker_identity), lease_expires_at = now() + interval '20 minutes',
    attempt_count = jobs.attempt_count + 1, progress_phase = 'preparing',
    progress_detail = 'Loading captured visual assets for private analysis.', error_summary = null
  from candidate where jobs.id = candidate.id returning jobs.*;
end; $$;

create or replace function public.claim_next_website_audit(worker_identity text)
returns setof public.audits
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'A service-role worker is required.'; end if;
  update public.audits set status = 'failed', worker_id = null, lease_expires_at = null,
    progress_phase = 'cancelled', progress_detail = 'Audit cancelled before a worker could safely stop.',
    error_summary = 'Website audit cancelled by a workspace user.'
  where status = 'running' and cancel_requested_at is not null;
  return query with candidate as (
    select id from public.audits
    where crawl_run_id is not null and (status = 'queued' or (status = 'running' and lease_expires_at < now()))
      and cancel_requested_at is null and attempt_count < 3
    order by created_at for update skip locked limit 1
  ) update public.audits as audits set
    status = 'running', worker_id = trim(worker_identity), lease_expires_at = now() + interval '10 minutes',
    attempt_count = audits.attempt_count + 1, progress_phase = 'preparing',
    progress_detail = 'Loading the completed private capture evidence.', error_summary = null
  from candidate where audits.id = candidate.id returning audits.*;
end; $$;
