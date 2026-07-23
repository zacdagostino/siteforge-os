create or replace function public.delete_website_build_history(target_business_id uuid)
returns void
language plpgsql
security definer
set search_path = public, storage
as $$
declare target_organization_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required.'; end if;
  select organization_id into target_organization_id from public.businesses where id = target_business_id;
  if target_organization_id is null or not public.is_organization_member(target_organization_id) then raise exception 'Organization membership is required.'; end if;
  if exists (select 1 from public.builder_runs where business_id = target_business_id and status in ('queued','running','paused')) then raise exception 'Cancel active builds before deleting build history.'; end if;
  delete from storage.objects as object
    where object.bucket_id = 'siteforge-artifacts'
      and exists (
        select 1 from public.builder_runs as run
          where run.business_id = target_business_id
            and object.name like target_organization_id::text || '/builder-runs/' || run.id::text || '/%'
      );
  delete from public.builder_runs where business_id = target_business_id;
end;
$$;
grant execute on function public.delete_website_build_history(uuid) to authenticated;
