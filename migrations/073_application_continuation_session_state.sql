alter table if exists applications
  add column if not exists application_status text not null default 'in_progress',
  add column if not exists current_step integer not null default 1,
  add column if not exists last_updated timestamptz not null default now(),
  add column if not exists is_completed boolean not null default false;

update applications
set application_status = case
      when application_status is null or application_status = '' then coalesce(status, pipeline_state, 'in_progress')
      else application_status
    end,
    current_step = coalesce(current_step, 1),
    last_updated = coalesce(last_updated, updated_at, created_at, now()),
    is_completed = coalesce(is_completed, false)
where application_status is null
   or application_status = ''
   or current_step is null
   or last_updated is null
   or is_completed is null;

alter table if exists continuation_sessions
  add column if not exists application_status text not null default 'in_progress',
  add column if not exists current_step integer not null default 1,
  add column if not exists last_updated timestamptz not null default now(),
  add column if not exists is_completed boolean not null default false;

update continuation_sessions
set application_status = case
      when application_status is null or application_status = '' then 'in_progress'
      else application_status
    end,
    current_step = coalesce(current_step, 1),
    last_updated = coalesce(last_updated, created_at, now()),
    is_completed = coalesce(is_completed, false)
where application_status is null
   or application_status = ''
   or current_step is null
   or last_updated is null
   or is_completed is null;
