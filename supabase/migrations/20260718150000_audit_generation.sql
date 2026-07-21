alter table public.audits
  add column if not exists worker_id text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0
    check (attempt_count >= 0),
  add column if not exists error_summary text;

alter table public.audit_findings
  add column if not exists review_state public.review_state not null default 'needs_review',
  add column if not exists source_urls text[] not null default '{}';

create index if not exists audits_worker_lease_idx
  on public.audits (status, lease_expires_at);

-- An audit is explicitly requested after a completed capture. The request carries the exact
-- capture run it may inspect, so it can never silently analyse a newer or older website state.
create or replace function public.request_website_audit(target_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
  latest_capture_id uuid;
  latest_audit public.audits;
  next_version integer;
  requested_audit_id uuid;
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

  select runs.id
  into latest_capture_id
  from public.crawl_runs as runs
  join public.websites as websites on websites.id = runs.website_id
  where websites.business_id = target_business_id
    and runs.status = 'ready'
  order by runs.completed_at desc nulls last, runs.requested_at desc
  limit 1;

  if latest_capture_id is null then
    raise exception 'A completed website capture is required before an audit can be generated.';
  end if;

  select *
  into latest_audit
  from public.audits
  where business_id = target_business_id
  order by version desc
  limit 1;

  if latest_audit.id is not null
    and latest_audit.status in ('queued', 'running')
    and latest_audit.crawl_run_id is not null then
    return latest_audit.id;
  end if;

  if latest_audit.id is null
    or latest_audit.status = 'ready' then
    select coalesce(max(version), 0) + 1
    into next_version
    from public.audits
    where business_id = target_business_id;

    insert into public.audits (organization_id, business_id, crawl_run_id, status, version)
    values (target_organization_id, target_business_id, latest_capture_id, 'queued', next_version)
    returning id into requested_audit_id;
  else
    update public.audits
    set
      crawl_run_id = latest_capture_id,
      status = 'queued',
      worker_id = null,
      lease_expires_at = null,
      attempt_count = 0,
      error_summary = null
    where id = latest_audit.id
    returning id into requested_audit_id;
  end if;

  insert into public.activities (organization_id, business_id, type, message)
  values (
    target_organization_id,
    target_business_id,
    'note',
    'Automated audit requested. It will analyse the latest completed private capture.'
  );

  return requested_audit_id;
end;
$$;

grant execute on function public.request_website_audit(uuid) to authenticated;

create or replace function public.claim_next_website_audit(worker_identity text)
returns setof public.audits
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

  update public.audits
  set
    status = 'failed',
    worker_id = null,
    lease_expires_at = null,
    error_summary = 'Audit worker lease expired after repeated attempts.'
  where status = 'running'
    and lease_expires_at < now()
    and attempt_count >= 3;

  return query
  with candidate as (
    select id
    from public.audits
    where crawl_run_id is not null
      and (
        status = 'queued'
        or (status = 'running' and lease_expires_at < now())
      )
      and attempt_count < 3
    order by created_at
    for update skip locked
    limit 1
  )
  update public.audits as audits
  set
    status = 'running',
    worker_id = trim(worker_identity),
    lease_expires_at = now() + interval '10 minutes',
    attempt_count = audits.attempt_count + 1,
    error_summary = null
  from candidate
  where audits.id = candidate.id
  returning audits.*;
end;
$$;

revoke all on function public.claim_next_website_audit(text) from public, anon, authenticated;
grant execute on function public.claim_next_website_audit(text) to service_role;
