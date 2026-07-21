create table public.builder_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  build_manifest_id uuid not null references public.build_manifests on delete restrict,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'ready', 'failed', 'cancelled')),
  template_version text not null,
  model text,
  worker_id text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  progress_phase text not null default 'queued',
  progress_detail text,
  total_items integer not null default 0 check (total_items >= 0),
  completed_items integer not null default 0 check (completed_items >= 0),
  cancel_requested_at timestamptz,
  input_hash text,
  codex_thread_id text,
  quality_summary jsonb not null default '{}'::jsonb,
  error_summary text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index builder_runs_business_created_idx
  on public.builder_runs (business_id, created_at desc);
create index builder_runs_worker_lease_idx
  on public.builder_runs (status, lease_expires_at);

create table public.builder_artifacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  builder_run_id uuid not null references public.builder_runs on delete cascade,
  kind text not null check (kind in ('source_bundle', 'site_file', 'screenshot', 'log', 'quality')),
  label text not null default '',
  storage_bucket text not null default 'siteforge-artifacts',
  storage_path text not null unique,
  content_type text,
  byte_size bigint check (byte_size >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index builder_artifacts_run_idx
  on public.builder_artifacts (builder_run_id, kind, created_at);

create table public.builder_preview_access (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  builder_run_id uuid not null references public.builder_runs on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index builder_preview_access_run_expiry_idx
  on public.builder_preview_access (builder_run_id, expires_at desc);

alter table public.builder_runs enable row level security;
alter table public.builder_artifacts enable row level security;
alter table public.builder_preview_access enable row level security;

create policy "Members can manage builder runs" on public.builder_runs
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create policy "Members can manage builder artifacts" on public.builder_artifacts
  for all to authenticated
  using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create trigger set_builder_runs_updated_at before update on public.builder_runs
  for each row execute procedure public.set_updated_at();

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
    and status in ('queued', 'running')
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

grant execute on function public.request_website_build(uuid) to authenticated;

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
    and status in ('queued', 'running')
  order by created_at desc
  limit 1
  for update;
  if target_run.id is null then
    raise exception 'There is no active private preview build to cancel.';
  end if;

  update public.builder_runs
  set
    status = case when target_run.status = 'queued' then 'cancelled' else status end,
    completed_at = case when target_run.status = 'queued' then now_at else completed_at end,
    lease_expires_at = case when target_run.status = 'queued' then null else lease_expires_at end,
    cancel_requested_at = now_at,
    progress_phase = 'cancelled',
    progress_detail = 'Cancellation requested. The builder will stop after its current safe step.',
    error_summary = 'Private preview build cancelled by a workspace user.'
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

grant execute on function public.cancel_website_build(uuid) to authenticated;

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
    error_summary = 'Builder worker lease expired after repeated attempts.'
  where status = 'running'
    and cancel_requested_at is null
    and lease_expires_at < now()
    and attempt_count >= 2;

  return query
  with candidate as (
    select id
    from public.builder_runs
    where (status = 'queued' or (status = 'running' and lease_expires_at < now()))
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
    attempt_count = runs.attempt_count + 1,
    progress_phase = 'preparing_workspace',
    progress_detail = 'Preparing an isolated website workspace for the approved Build Manifest.',
    error_summary = null
  from candidate
  where runs.id = candidate.id
  returning runs.*;
end;
$$;

revoke all on function public.claim_next_website_build(text) from public, anon, authenticated;
grant execute on function public.claim_next_website_build(text) to service_role;

create or replace function public.create_builder_preview_access(target_builder_run_id uuid)
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

  select * into target_run
  from public.builder_runs
  where id = target_builder_run_id;
  if target_run.id is null
    or target_run.status <> 'ready'
    or not public.is_organization_member(target_run.organization_id) then
    raise exception 'A completed private preview build is required.';
  end if;

  raw_token := encode(gen_random_bytes(32), 'hex');
  insert into public.builder_preview_access (
    organization_id,
    builder_run_id,
    token_hash,
    expires_at
  ) values (
    target_run.organization_id,
    target_run.id,
    encode(digest(raw_token, 'sha256'), 'hex'),
    expires_at_value
  );

  return jsonb_build_object(
    'token', raw_token,
    'expires_at', expires_at_value
  );
end;
$$;

grant execute on function public.create_builder_preview_access(uuid) to authenticated;

update storage.buckets
set allowed_mime_types = (
  select array_agg(distinct mime_type)
  from unnest(
    coalesce(allowed_mime_types, '{}') || array[
      'text/css',
      'text/javascript',
      'application/javascript',
      'application/json',
      'application/gzip',
      'application/zip',
      'font/woff2',
      'font/woff',
      'image/avif'
    ]
  ) as mime_type
)
where id = 'siteforge-artifacts';
