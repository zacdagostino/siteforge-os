alter table public.builder_artifacts
  drop constraint builder_artifacts_kind_check;

alter table public.builder_artifacts
  add constraint builder_artifacts_kind_check
  check (kind in (
    'source_bundle',
    'site_file',
    'draft_file',
    'checkpoint',
    'screenshot',
    'log',
    'quality'
  ));

create index builder_artifacts_checkpoint_idx
  on public.builder_artifacts (builder_run_id, kind, created_at desc)
  where kind = 'checkpoint';
