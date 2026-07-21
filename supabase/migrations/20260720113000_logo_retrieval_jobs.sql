create table public.logo_retrieval_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  website_id uuid not null references public.websites on delete cascade,
  target_url text not null,
  status public.job_status not null default 'queued',
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  worker_id text,
  lease_expires_at timestamptz,
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index logo_retrieval_jobs_next_idx
  on public.logo_retrieval_jobs (status, lease_expires_at, requested_at);

alter table public.logo_retrieval_jobs enable row level security;

create policy "Members can manage logo retrieval jobs" on public.logo_retrieval_jobs
  for all using (public.is_organization_member(organization_id))
  with check (public.is_organization_member(organization_id));

create trigger set_logo_retrieval_jobs_updated_at before update on public.logo_retrieval_jobs
  for each row execute procedure public.set_updated_at();

create or replace function public.request_logo_retrieval(target_business_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
  target_website public.websites;
  active_job_id uuid;
  new_job_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'Authentication is required.'; end if;
  select organization_id into target_organization_id from public.businesses where id = target_business_id;
  if target_organization_id is null or not public.is_organization_member(target_organization_id) then
    raise exception 'Organization membership is required.';
  end if;
  select * into target_website from public.websites
    where business_id = target_business_id and organization_id = target_organization_id
    order by created_at limit 1;
  if target_website.id is null then raise exception 'A website is required before retrieving a logo.'; end if;
  select id into active_job_id from public.logo_retrieval_jobs
    where website_id = target_website.id and status in ('queued', 'running')
    order by requested_at desc limit 1;
  if active_job_id is not null then return active_job_id; end if;
  insert into public.logo_retrieval_jobs (id, organization_id, business_id, website_id, target_url)
    values (new_job_id, target_organization_id, target_business_id, target_website.id, target_website.url);
  return new_job_id;
end;
$$;

create or replace function public.claim_next_logo_retrieval(worker_identity text)
returns setof public.logo_retrieval_jobs
language plpgsql
security definer
set search_path = public
as $$
declare target_job public.logo_retrieval_jobs;
begin
  select * into target_job from public.logo_retrieval_jobs
    where status = 'queued' or (status = 'running' and lease_expires_at < now())
    order by requested_at for update skip locked limit 1;
  if target_job.id is null then return; end if;
  update public.logo_retrieval_jobs set status = 'running', started_at = coalesce(started_at, now()),
    worker_id = worker_identity, lease_expires_at = now() + interval '2 minutes', error_summary = null
    where id = target_job.id returning * into target_job;
  return next target_job;
end;
$$;

insert into public.logo_retrieval_jobs (organization_id, business_id, website_id, target_url)
select websites.organization_id, websites.business_id, websites.id, websites.url
from public.websites as websites
where not exists (
  select 1 from public.artifacts
  where artifacts.business_id = websites.business_id
    and artifacts.kind = 'asset'
    and artifacts.metadata ->> 'preferredOrganisationLogo' = 'true'
);

revoke all on function public.claim_next_logo_retrieval(text) from public, anon, authenticated;
grant execute on function public.request_logo_retrieval(uuid) to authenticated;
grant execute on function public.claim_next_logo_retrieval(text) to service_role;
