create or replace function public.delete_build_package(
  target_business_id uuid,
  target_redesign_brief_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  target_organization_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required.'; end if;

  select organization_id into target_organization_id
  from public.businesses
  where id = target_business_id;

  if target_organization_id is null
    or not public.is_organization_member(target_organization_id) then
    raise exception 'Organization membership is required.';
  end if;

  if not exists (
    select 1
    from public.redesign_briefs
    where id = target_redesign_brief_id
      and business_id = target_business_id
      and organization_id = target_organization_id
  ) then
    raise exception 'Build package not found.';
  end if;

  if exists (
    select 1
    from public.builder_runs as run
    join public.build_manifests as manifest on manifest.id = run.build_manifest_id
    where manifest.redesign_brief_id = target_redesign_brief_id
      and run.status in ('queued', 'running', 'paused')
  ) then
    raise exception 'Cancel active builds before deleting this build package.';
  end if;

  delete from storage.objects as object
  where object.bucket_id = 'siteforge-artifacts'
    and exists (
      select 1
      from public.builder_runs as run
      join public.build_manifests as manifest on manifest.id = run.build_manifest_id
      where manifest.redesign_brief_id = target_redesign_brief_id
        and object.name like target_organization_id::text || '/builder-runs/' || run.id::text || '/%'
    );

  delete from public.builder_runs as run
  using public.build_manifests as manifest
  where run.build_manifest_id = manifest.id
    and manifest.redesign_brief_id = target_redesign_brief_id;

  delete from public.build_manifests
  where redesign_brief_id = target_redesign_brief_id;

  delete from public.redesign_briefs
  where id = target_redesign_brief_id;
end;
$$;

grant execute on function public.delete_build_package(uuid, uuid) to authenticated;
