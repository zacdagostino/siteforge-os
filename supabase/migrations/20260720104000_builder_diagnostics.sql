alter table public.builder_events
  drop constraint builder_events_kind_check;

alter table public.builder_events
  add constraint builder_events_kind_check
  check (kind in ('stage', 'activity', 'file', 'quality', 'diagnostic', 'error'));
