alter table public.crawl_runs
  add column if not exists worker_id text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0
    check (attempt_count >= 0);

alter table public.artifacts
  add column if not exists label text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.evidence_facts
  add column if not exists crawl_run_id uuid references public.crawl_runs on delete set null;

create index if not exists crawl_runs_worker_lease_idx
  on public.crawl_runs (status, lease_expires_at);
create index if not exists evidence_facts_crawl_run_idx
  on public.evidence_facts (crawl_run_id, captured_at);

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
    lease_expires_at = now() + interval '10 minutes',
    attempt_count = runs.attempt_count + 1,
    error_summary = null
  from candidate
  where runs.id = candidate.id
  returning runs.*;
end;
$$;

revoke all on function public.claim_next_homepage_capture(text) from public, anon, authenticated;
grant execute on function public.claim_next_homepage_capture(text) to service_role;
