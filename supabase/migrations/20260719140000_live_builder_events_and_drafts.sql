create table public.builder_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations on delete cascade,
  business_id uuid not null references public.businesses on delete cascade,
  builder_run_id uuid not null references public.builder_runs on delete cascade,
  sequence integer not null check (sequence > 0),
  kind text not null check (kind in ('stage', 'activity', 'file', 'quality', 'error')),
  message text not null check (char_length(trim(message)) > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (builder_run_id, sequence)
);

create index builder_events_run_sequence_idx
  on public.builder_events (builder_run_id, sequence desc);

alter table public.builder_events enable row level security;

create policy "Members can read builder events" on public.builder_events
  for select to authenticated
  using (public.is_organization_member(organization_id));

alter table public.builder_artifacts
  drop constraint builder_artifacts_kind_check;
alter table public.builder_artifacts
  add constraint builder_artifacts_kind_check
  check (kind in ('source_bundle', 'site_file', 'draft_file', 'screenshot', 'log', 'quality'));

alter table public.builder_preview_access
  add column preview_mode text not null default 'ready'
  check (preview_mode in ('ready', 'draft'));

drop function public.create_builder_preview_access(uuid);

create function public.create_builder_preview_access(
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
  if requested_mode = 'ready' and target_run.status <> 'ready' then
    raise exception 'A completed private preview build is required.';
  end if;
  if requested_mode = 'draft' and target_run.status <> 'running' then
    raise exception 'A running private preview build is required.';
  end if;
  if requested_mode = 'draft' and not exists (
    select 1 from public.builder_artifacts
    where builder_run_id = target_builder_run_id
      and kind = 'draft_file'
      and storage_path = target_run.organization_id::text || '/builder-runs/' || target_builder_run_id::text || '/draft/index.html'
  ) then
    raise exception 'The builder has not produced a viewable draft yet.';
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

grant execute on function public.create_builder_preview_access(uuid, text) to authenticated;
