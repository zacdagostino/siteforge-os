create or replace function public.canonical_website_url(raw_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(lower(trim(raw_url)), '^https?://', ''),
      '[?#].*$',
      ''
    ),
    '/+$',
    ''
  )
$$;

alter table public.websites
  add column canonical_url text generated always as (public.canonical_website_url(url)) stored;

create unique index websites_organization_canonical_url_key
  on public.websites (organization_id, canonical_url);
