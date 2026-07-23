create or replace function public.delete_website_build(target_builder_run_id uuid)
returns void
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  target_run public.builder_runs;
begin
  if auth.uid() is null then raise exception 'Authentication is required.'; end if;
  select * into target_run from public.builder_runs where id = target_builder_run_id for update;
  if target_run.id is null or not public.is_organization_member(target_run.organization_id) then
    raise exception 'Organization membership is required.';
  end if;
  if target_run.status in ('queued', 'running', 'paused') then
    raise exception 'Cancel the active build before deleting it.';
  end if;
  delete from storage.objects
    where bucket_id = 'siteforge-artifacts'
      and name like target_run.organization_id::text || '/builder-runs/' || target_run.id::text || '/%';
  delete from public.builder_runs where id = target_run.id;
end;
$$;

grant execute on function public.delete_website_build(uuid) to authenticated;
