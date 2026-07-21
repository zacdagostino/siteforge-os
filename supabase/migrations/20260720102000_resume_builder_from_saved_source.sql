create or replace function public.resume_website_build(target_builder_run_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_run public.builder_runs;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  select * into target_run
  from public.builder_runs
  where id = target_builder_run_id
  for update;

  if target_run.id is null
    or not public.is_organization_member(target_run.organization_id) then
    raise exception 'Organization membership is required.';
  end if;
  if target_run.status not in ('failed', 'cancelled') then
    raise exception 'Only a stopped private preview build can be resumed.';
  end if;
  if not exists (
    select 1
    from public.builder_artifacts
    where builder_run_id = target_run.id
      and (
        (kind = 'checkpoint' and label = 'Latest private source checkpoint')
        or kind = 'draft_file'
      )
  ) then
    raise exception 'No saved private source is available for this build.';
  end if;

  update public.builder_runs
  set
    status = 'queued',
    worker_id = null,
    lease_expires_at = null,
    attempt_count = 0,
    cancel_requested_at = null,
    retry_after = null,
    progress_phase = 'queued',
    progress_detail = 'Resuming from saved private source.',
    error_summary = null,
    failure_code = null,
    failure_stage = null,
    failure_action = null,
    failure_context = '{}'::jsonb,
    completed_at = null
  where id = target_run.id;

  insert into public.activities (organization_id, business_id, type, message)
  values (
    target_run.organization_id,
    target_run.business_id,
    'note',
    'Private redesign preview resumed from saved protected source.'
  );

  return target_run.id;
end;
$$;
