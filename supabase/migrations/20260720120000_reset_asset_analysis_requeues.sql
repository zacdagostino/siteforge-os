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
  from public.businesses
  where id = target_business_id;
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

  select * into existing_job
  from public.asset_analysis_jobs
  where crawl_run_id = latest_capture_id;
  if existing_job.id is not null
    and existing_job.status in ('queued', 'running')
    and existing_job.cancel_requested_at is null then
    return existing_job.id;
  end if;

  insert into public.asset_analysis_jobs (organization_id, business_id, crawl_run_id, status)
  values (target_organization_id, target_business_id, latest_capture_id, 'queued')
  on conflict (crawl_run_id) do update set
    status = 'queued',
    worker_id = null,
    lease_expires_at = null,
    attempt_count = 0,
    cancel_requested_at = null,
    progress_phase = 'queued',
    progress_detail = 'Private visual-asset analysis requested. Waiting for the protected worker.',
    current_asset_id = null,
    total_items = 0,
    completed_items = 0,
    error_summary = null
  returning id into requested_job_id;

  insert into public.activities (organization_id, business_id, type, message)
  values (
    target_organization_id,
    target_business_id,
    'note',
    'Private visual-asset analysis requested. Suggestions require human review before reuse.'
  );
  return requested_job_id;
end;
$$;

grant execute on function public.request_asset_analysis(uuid) to authenticated;
