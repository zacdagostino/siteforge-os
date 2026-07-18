-- Browser clients can request one private homepage capture. A server-side worker will claim,
-- process, and complete these rows; it is never invoked directly by the browser.
alter table public.crawl_runs
  add column if not exists requested_by uuid references auth.users on delete set null,
  add column if not exists capture_scope text not null default 'homepage'
    check (capture_scope in ('homepage')),
  add column if not exists target_url text;

update public.crawl_runs as runs
set target_url = websites.url
from public.websites as websites
where runs.website_id = websites.id
  and runs.target_url is null;

alter table public.crawl_runs
  alter column target_url set not null;

create unique index if not exists crawl_runs_one_active_homepage_capture_per_website
  on public.crawl_runs (website_id)
  where status in ('queued', 'running');

create or replace function public.request_homepage_capture(target_business_id uuid)
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
    'homepage',
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
    'Homepage capture requested. Evidence will remain private until a worker completes it.'
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

grant execute on function public.request_homepage_capture(uuid) to authenticated;
