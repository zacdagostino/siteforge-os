alter table public.builder_runs
  drop constraint builder_runs_status_check;
alter table public.builder_runs
  add constraint builder_runs_status_check
  check (status in ('queued', 'running', 'paused', 'ready', 'review_required', 'failed', 'cancelled'));

alter table public.builder_runs
  add column failure_code text,
  add column failure_stage text,
  add column failure_action text,
  add column failure_context jsonb not null default '{}'::jsonb,
  add column retry_after timestamptz;

create index builder_runs_retry_idx
  on public.builder_runs (status, retry_after)
  where status = 'paused';

create or replace function public.request_website_build(target_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
  target_manifest public.build_manifests;
  existing_run public.builder_runs;
  requested_run_id uuid;
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

  select * into target_manifest
  from public.build_manifests
  where business_id = target_business_id
    and organization_id = target_organization_id
    and status = 'ready'
  order by generated_at desc
  limit 1;
  if target_manifest.id is null then
    raise exception 'An approved Build Manifest is required before a private preview can be generated.';
  end if;

  select * into existing_run
  from public.builder_runs
  where business_id = target_business_id
    and build_manifest_id = target_manifest.id
    and status in ('queued', 'running', 'paused')
  order by created_at desc
  limit 1;
  if existing_run.id is not null then
    return existing_run.id;
  end if;

  insert into public.builder_runs (
    organization_id,
    business_id,
    build_manifest_id,
    status,
    template_version,
    progress_phase,
    progress_detail
  ) values (
    target_organization_id,
    target_business_id,
    target_manifest.id,
    'queued',
    'siteforge-static-builder-v1',
    'queued',
    'Waiting for the protected Codex builder worker.'
  ) returning id into requested_run_id;

  insert into public.activities (organization_id, business_id, type, message)
  values (
    target_organization_id,
    target_business_id,
    'note',
    'Private redesign preview requested from the approved Build Manifest.'
  );
  return requested_run_id;
end;
$$;

create or replace function public.cancel_website_build(target_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
  target_run public.builder_runs;
  now_at timestamptz := now();
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

  select * into target_run
  from public.builder_runs
  where business_id = target_business_id
    and status in ('queued', 'running', 'paused')
  order by created_at desc
  limit 1
  for update;
  if target_run.id is null then
    raise exception 'There is no active private preview build to cancel.';
  end if;

  update public.builder_runs
  set
    status = case when target_run.status in ('queued', 'paused') then 'cancelled' else status end,
    completed_at = case when target_run.status in ('queued', 'paused') then now_at else completed_at end,
    lease_expires_at = case when target_run.status in ('queued', 'paused') then null else lease_expires_at end,
    retry_after = null,
    cancel_requested_at = now_at,
    progress_phase = 'cancelled',
    progress_detail = 'Cancellation requested. The builder will stop after its current safe step.',
    error_summary = 'Private preview build cancelled by a workspace user.',
    failure_code = 'cancelled_by_user',
    failure_stage = 'cancelled',
    failure_action = 'Review any saved frozen draft or start a new build from the same approved manifest.'
  where id = target_run.id;

  insert into public.activities (organization_id, business_id, type, message)
  values (
    target_organization_id,
    target_business_id,
    'note',
    'Private redesign preview cancellation requested. Any saved build artifacts remain private.'
  );
  return target_run.id;
end;
$$;

create or replace function public.claim_next_website_build(worker_identity text)
returns setof public.builder_runs
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'A service-role worker is required.';
  end if;
  if char_length(trim(worker_identity)) = 0 or char_length(trim(worker_identity)) > 120 then
    raise exception 'A valid worker identity is required.';
  end if;

  update public.builder_runs
  set
    status = 'failed',
    completed_at = now(),
    lease_expires_at = null,
    progress_phase = 'failed',
    progress_detail = 'The builder worker lease expired after repeated attempts.',
    error_summary = 'Builder worker lease expired after repeated attempts.',
    failure_code = 'worker_lease_expired',
    failure_stage = 'worker_runtime',
    failure_action = 'Start a new build from the same approved manifest after confirming the worker runtime is available.'
  where status = 'running'
    and cancel_requested_at is null
    and lease_expires_at < now()
    and attempt_count >= 2;

  return query
  with candidate as (
    select id
    from public.builder_runs
    where (
      status = 'queued'
      or (status = 'paused' and retry_after <= now())
      or (status = 'running' and lease_expires_at < now())
    )
      and cancel_requested_at is null
      and attempt_count < 2
    order by created_at
    for update skip locked
    limit 1
  )
  update public.builder_runs as runs
  set
    status = 'running',
    started_at = coalesce(runs.started_at, now()),
    worker_id = trim(worker_identity),
    lease_expires_at = now() + interval '45 minutes',
    retry_after = null,
    attempt_count = runs.attempt_count + 1,
    progress_phase = 'preparing_workspace',
    progress_detail = 'Preparing an isolated website workspace for the approved Build Manifest.',
    error_summary = null,
    failure_code = null,
    failure_stage = null,
    failure_action = null,
    failure_context = '{}'::jsonb
  from candidate
  where runs.id = candidate.id
  returning runs.*;
end;
$$;

create or replace function public.create_builder_preview_access(
  target_builder_run_id uuid,
  requested_mode text default 'ready'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_run public.builder_runs;
  raw_token text;
  expires_at_value timestamptz := now() + interval '30 minutes';
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;
  if requested_mode not in ('ready', 'draft') then
    raise exception 'A valid private preview mode is required.';
  end if;

  select * into target_run
  from public.builder_runs
  where id = target_builder_run_id;
  if target_run.id is null
    or not public.is_organization_member(target_run.organization_id) then
    raise exception 'Organization membership is required.';
  end if;
  if requested_mode = 'ready' and target_run.status not in ('ready', 'review_required') then
    raise exception 'A completed private preview build is required.';
  end if;
  if requested_mode = 'draft' and target_run.status not in ('running', 'paused', 'failed', 'cancelled') then
    raise exception 'A running, paused, failed, or cancelled private preview build is required.';
  end if;
  if requested_mode = 'draft' and not exists (
    select 1 from public.builder_artifacts
    where builder_run_id = target_builder_run_id
      and kind = 'draft_file'
      and storage_path = target_run.organization_id::text || '/builder-runs/' || target_builder_run_id::text || '/draft/index.html'
  ) then
    raise exception 'The builder did not save a viewable draft before stopping.';
  end if;

  raw_token := encode(gen_random_bytes(32), 'hex');
  insert into public.builder_preview_access (
    organization_id,
    builder_run_id,
    token_hash,
    preview_mode,
    expires_at
  ) values (
    target_run.organization_id,
    target_run.id,
    encode(digest(raw_token, 'sha256'), 'hex'),
    requested_mode,
    expires_at_value
  );

  return jsonb_build_object(
    'token', raw_token,
    'expires_at', expires_at_value,
    'mode', requested_mode
  );
end;
$$;
