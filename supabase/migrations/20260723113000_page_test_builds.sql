alter table public.builder_runs
  add column target_source_url text;

alter table public.builder_runs
  drop constraint if exists builder_runs_build_mode_check;

alter table public.builder_runs
  add constraint builder_runs_build_mode_check
  check (build_mode in ('homepage_test', 'page_test', 'full_site'));

drop function if exists public.request_website_build(uuid, text);

create function public.request_website_build(
  target_business_id uuid,
  requested_mode text default 'homepage_test',
  requested_target_source_url text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
  target_manifest public.build_manifests;
  existing_run public.builder_runs;
  homepage_test_run public.builder_runs;
  requested_run_id uuid;
  source_is_selected boolean := false;
begin
  if auth.uid() is null then raise exception 'Authentication is required.'; end if;
  if requested_mode not in ('homepage_test', 'page_test', 'full_site') then
    raise exception 'A valid website build mode is required.';
  end if;

  select organization_id into target_organization_id
  from public.businesses
  where id = target_business_id;

  if target_organization_id is null
    or not public.is_organization_member(target_organization_id) then
    raise exception 'Organization membership is required.';
  end if;

  select * into target_manifest
  from public.build_manifests
  where business_id = target_business_id
    and organization_id = target_organization_id
    and status = 'ready'
  order by generated_at desc
  limit 1;

  if target_manifest.id is null then
    raise exception 'An approved Build Manifest is required before a private preview can be generated.';
  end if;

  if requested_mode = 'page_test' then
    if requested_target_source_url is null or trim(requested_target_source_url) = '' then
      raise exception 'Choose a selected source page to test.';
    end if;
    select exists (
      select 1
      from jsonb_array_elements(coalesce(target_manifest.data -> 'selectedPages', '[]'::jsonb)) as page
      where page ->> 'url' = requested_target_source_url
        and coalesce(nullif(trim(page ->> 'url'), ''), '') <> ''
    ) into source_is_selected;
    if not source_is_selected then
      raise exception 'The selected page is not part of this Build Manifest.';
    end if;
  elsif requested_target_source_url is not null then
    raise exception 'Only a page test may target a single source page.';
  end if;

  select * into existing_run
  from public.builder_runs
  where business_id = target_business_id
    and build_manifest_id = target_manifest.id
    and build_mode = requested_mode
    and coalesce(target_source_url, '') = coalesce(requested_target_source_url, '')
    and status in ('queued', 'running', 'paused')
  order by created_at desc
  limit 1;

  if existing_run.id is not null then return existing_run.id; end if;

  if requested_mode in ('page_test', 'full_site') then
    select * into homepage_test_run
    from public.builder_runs as candidate
    where candidate.business_id = target_business_id
      and candidate.build_manifest_id = target_manifest.id
      and candidate.build_mode in ('homepage_test', 'page_test')
      and candidate.status in ('ready', 'review_required')
      and exists (
        select 1
        from public.builder_artifacts
        where builder_run_id = candidate.id
          and kind = 'checkpoint'
      )
    order by created_at desc
    limit 1;

    if homepage_test_run.id is null then
      raise exception 'Complete a homepage test before building another page or the full website.';
    end if;
  end if;

  insert into public.builder_runs (
    organization_id,
    business_id,
    build_manifest_id,
    parent_builder_run_id,
    build_mode,
    target_source_url,
    status,
    template_version,
    progress_phase,
    progress_detail
  ) values (
    target_organization_id,
    target_business_id,
    target_manifest.id,
    homepage_test_run.id,
    requested_mode,
    requested_target_source_url,
    'queued',
    'siteforge-static-builder-v1',
    'queued',
    case requested_mode
      when 'homepage_test' then 'Waiting to build the homepage test preview.'
      when 'page_test' then 'Waiting to build the selected page test preview.'
      else 'Waiting to build the full website preview.'
    end
  ) returning id into requested_run_id;

  insert into public.activities (organization_id, business_id, type, message)
  values (
    target_organization_id,
    target_business_id,
    'note',
    case requested_mode
      when 'homepage_test' then 'Homepage test preview requested.'
      when 'page_test' then 'Selected page test preview requested.'
      else 'Full website preview requested.'
    end
  );

  return requested_run_id;
end;
$$;

grant execute on function public.request_website_build(uuid, text, text) to authenticated;
