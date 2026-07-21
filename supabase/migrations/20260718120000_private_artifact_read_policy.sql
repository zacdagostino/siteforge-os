create policy "Organization members can read private capture files"
on storage.objects for select to authenticated
using (
  bucket_id = 'siteforge-artifacts'
  and exists (
    select 1
    from public.organization_members
    where organization_members.user_id = auth.uid()
      and organization_members.organization_id = split_part(name, '/', 1)::uuid
  )
);
