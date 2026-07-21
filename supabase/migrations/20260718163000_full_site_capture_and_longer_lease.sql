alter table public.crawl_runs
  drop constraint if exists crawl_runs_capture_scope_check;

alter table public.crawl_runs
  add constraint crawl_runs_capture_scope_check
  check (capture_scope in ('homepage', 'key_pages', 'all_pages'));

create or replace function public.request_website_capture(target_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
  target_website_id uuid;
  target_website_url text;
  existing_capture_id uuid;
  new_capture_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  select organization_id
  into target_organization_id
  from public.businesses
  where id = target_business_id;

  if target_organization_id is null
    or not public.is_organization_member(target_organization_id) then
    raise exception 'Organization membership is required.';
  end if;

  select id, url
  into target_website_id, target_website_url
  from public.websites
  where business_id = target_business_id
    and organization_id = target_organization_id
  order by created_at
  limit 1;

  if target_website_id is null then
    raise exception 'A website is required before research can begin.';
  end if;

  select id
  into existing_capture_id
  from public.crawl_runs
  where website_id = target_website_id
    and status in ('queued', 'running')
  order by requested_at desc
  limit 1;

  if existing_capture_id is not null then
    return existing_capture_id;
  end if;

  insert into public.crawl_runs (
    id,
    organization_id,
    website_id,
    status,
    requested_by,
    capture_scope,
    target_url
  )
  values (
    new_capture_id,
    target_organization_id,
    target_website_id,
    'queued',
    auth.uid(),
    'all_pages',
    target_website_url
  );

  update public.websites
  set crawl_status = 'queued'
  where id = target_website_id;

  update public.audits
  set status = 'queued'
  where business_id = target_business_id
    and status in ('not_started', 'failed');

  insert into public.activities (organization_id, business_id, type, message)
  values (
    target_organization_id,
    target_business_id,
    'research_requested',
    'Full public-site capture requested. Discoverable pages will be saved as private evidence.'
  );

  return new_capture_id;
exception
  when unique_violation then
    select id
    into existing_capture_id
    from public.crawl_runs
    where website_id = target_website_id
      and status in ('queued', 'running')
    order by requested_at desc
    limit 1;
    return existing_capture_id;
end;
$$;

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
    error_summary = 'Capture worker lease expired after repeated attempts.'
  where status = 'running'
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
    error_summary = null
  from candidate
  where runs.id = candidate.id
  returning runs.*;
end;
$$;
