create table public.asset_refresh_jobs (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade, crawl_run_id uuid not null references public.crawl_runs on delete cascade,
  status public.job_status not null default 'queued', worker_id text, lease_expires_at timestamptz, heartbeat_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0), error_summary text, progress_phase text, progress_detail text, current_url text,
  total_items integer not null default 0, completed_items integer not null default 0, discovered_items integer not null default 0, saved_items integer not null default 0,
  cancel_requested_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index asset_refresh_jobs_business_idx on public.asset_refresh_jobs (business_id, created_at desc);
alter table public.asset_refresh_jobs enable row level security;
create policy "Members can manage asset refresh jobs" on public.asset_refresh_jobs for all to authenticated using (public.is_organization_member(organization_id)) with check (public.is_organization_member(organization_id));
create trigger set_asset_refresh_jobs_updated_at before update on public.asset_refresh_jobs for each row execute procedure public.set_updated_at();

create or replace function public.request_asset_refresh(target_business_id uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare org_id uuid; run_id uuid; job_id uuid; begin
 if auth.uid() is null then raise exception 'Authentication is required.'; end if;
 select organization_id into org_id from public.businesses where id = target_business_id;
 if org_id is null or not public.is_organization_member(org_id) then raise exception 'Organization membership is required.'; end if;
 select runs.id into run_id from public.crawl_runs runs join public.websites sites on sites.id = runs.website_id where sites.business_id = target_business_id and runs.status = 'ready' order by runs.completed_at desc nulls last limit 1;
 if run_id is null then raise exception 'A completed website capture is required before an image-only refresh.'; end if;
 select id into job_id from public.asset_refresh_jobs where crawl_run_id = run_id and status in ('queued','running') order by created_at desc limit 1;
 if job_id is not null then return job_id; end if;
 insert into public.asset_refresh_jobs (organization_id,business_id,crawl_run_id,progress_phase,progress_detail) values (org_id,target_business_id,run_id,'queued','Image-only refresh queued. Existing evidence and analysis are unchanged.') returning id into job_id;
 return job_id; end; $$;
grant execute on function public.request_asset_refresh(uuid) to authenticated;

create or replace function public.claim_next_asset_refresh(worker_identity text) returns setof public.asset_refresh_jobs language plpgsql security definer set search_path = public as $$ begin
 if auth.role() <> 'service_role' then raise exception 'A service-role worker is required.'; end if;
 return query with candidate as (select id from public.asset_refresh_jobs where (status='queued' or (status='running' and lease_expires_at < now())) and attempt_count < 3 order by created_at for update skip locked limit 1)
 update public.asset_refresh_jobs jobs set status='running',worker_id=trim(worker_identity),lease_expires_at=now()+interval '20 minutes',heartbeat_at=now(),attempt_count=jobs.attempt_count+1,error_summary=null from candidate where jobs.id=candidate.id returning jobs.*; end; $$;
revoke all on function public.claim_next_asset_refresh(text) from public, anon, authenticated; grant execute on function public.claim_next_asset_refresh(text) to service_role;
create or replace function public.cancel_asset_refresh(target_business_id uuid) returns void language plpgsql security definer set search_path = public as $$ begin
 if auth.uid() is null then raise exception 'Authentication is required.'; end if;
 update public.asset_refresh_jobs set cancel_requested_at=now(),progress_detail='Cancellation requested. The worker will stop after its current image.' where business_id=target_business_id and status in ('queued','running') and public.is_organization_member(organization_id); end; $$;
grant execute on function public.cancel_asset_refresh(uuid) to authenticated;
