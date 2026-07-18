create or replace function public.create_prospect_workspace(
  target_organization_id uuid,
  business_name text,
  website_url text,
  website_domain text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_business_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  if not public.is_organization_member(target_organization_id) then
    raise exception 'Organization membership is required.';
  end if;

  if char_length(trim(business_name)) = 0 or char_length(trim(website_url)) = 0 or char_length(trim(website_domain)) = 0 then
    raise exception 'Business name, website URL and domain are required.';
  end if;

  insert into public.businesses (id, organization_id, kind, name, stage, review_state)
  values (new_business_id, target_organization_id, 'prospect', trim(business_name), 'researching', 'needs_review');

  insert into public.websites (organization_id, business_id, url, domain, crawl_status)
  values (target_organization_id, new_business_id, trim(website_url), trim(website_domain), 'not_started');

  insert into public.audits (organization_id, business_id, status)
  values (target_organization_id, new_business_id, 'queued');

  insert into public.redesign_concepts (organization_id, business_id, summary)
  values (
    target_organization_id,
    new_business_id,
    'Awaiting verified research before a redesign concept can be drafted.'
  );

  insert into public.decision_reports (organization_id, business_id, summary)
  values (target_organization_id, new_business_id, 'Awaiting approved evidence and design decisions.');

  insert into public.tasks (organization_id, business_id, body)
  values
    (target_organization_id, new_business_id, 'Verify business identity, services, and contact details.'),
    (target_organization_id, new_business_id, 'Run research and capture evidence before approving any claims.');

  insert into public.activities (organization_id, business_id, type, message)
  values (
    target_organization_id,
    new_business_id,
    'research_requested',
    format('Prospect created from %s. Research is awaiting a crawler connection.', trim(website_domain))
  );

  return new_business_id;
end;
$$;

grant execute on function public.create_prospect_workspace(uuid, text, text, text) to authenticated;

create or replace function public.approve_business_for_outreach(target_business_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  select organization_id into target_organization_id
  from public.businesses
  where id = target_business_id;

  if target_organization_id is null or not public.is_organization_member(target_organization_id) then
    raise exception 'Organization membership is required.';
  end if;

  if not exists (
    select 1 from public.audits
    where business_id = target_business_id and status = 'ready'
  ) or not exists (
    select 1 from public.redesign_concepts
    where business_id = target_business_id and status = 'ready'
  ) then
    return false;
  end if;

  update public.businesses
  set stage = 'outreach_pending', review_state = 'approved'
  where id = target_business_id;

  insert into public.activities (organization_id, business_id, type, message)
  values (
    target_organization_id,
    target_business_id,
    'approved',
    'Research review approved for the next human-controlled outreach step.'
  );

  return true;
end;
$$;

grant execute on function public.approve_business_for_outreach(uuid) to authenticated;
