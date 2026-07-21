create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

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
    select 1
    from public.builder_artifacts
    where builder_run_id = target_builder_run_id
      and kind = 'draft_file'
      and storage_path = target_run.organization_id::text || '/builder-runs/' || target_builder_run_id::text || '/draft/index.html'
  ) then
    raise exception 'The builder did not save a viewable draft before stopping.';
  end if;

  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.builder_preview_access (
    organization_id,
    builder_run_id,
    token_hash,
    preview_mode,
    expires_at
  ) values (
    target_run.organization_id,
    target_run.id,
    encode(extensions.digest(raw_token, 'sha256'), 'hex'),
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
