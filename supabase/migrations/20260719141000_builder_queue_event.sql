create function public.record_builder_run_queued()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.builder_events (
    organization_id,
    business_id,
    builder_run_id,
    sequence,
    kind,
    message
  ) values (
    new.organization_id,
    new.business_id,
    new.id,
    1,
    'stage',
    'Private preview queued. Waiting for the protected Codex builder worker.'
  );
  return new;
end;
$$;

create trigger record_builder_run_queued after insert on public.builder_runs
  for each row execute procedure public.record_builder_run_queued();
