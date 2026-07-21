alter table public.crawl_runs
  drop constraint if exists crawl_runs_capture_scope_check;

alter table public.crawl_runs
  add constraint crawl_runs_capture_scope_check
  check (capture_scope in ('homepage', 'key_pages'));

alter table public.crawl_pages
  add column if not exists page_type text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.artifacts
  drop constraint if exists artifacts_kind_check;

alter table public.artifacts
  add constraint artifacts_kind_check
  check (kind in ('html', 'screenshot', 'content', 'performance', 'accessibility', 'report', 'preview'));

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
    'key_pages',
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
    'Website capture requested. Public key pages will be saved as private evidence.'
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

grant execute on function public.request_website_capture(uuid) to authenticated;
