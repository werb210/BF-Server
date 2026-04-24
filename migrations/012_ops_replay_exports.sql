create table if not exists ops_kill_switches (
  key text primary key,
  enabled boolean not null,
  updated_at timestamp not null
);

create table if not exists ops_replay_jobs (
  id text primary key,
  scope text not null,
  started_at timestamp null,
  completed_at timestamp null,
  status text not null
);

create table if not exists ops_replay_events (
  id text primary key,
  replay_job_id text references ops_replay_jobs(id) on delete cascade,
  source_table text not null,
  source_id text not null,
  processed_at timestamp null,
  unique (source_table, source_id)
);

create table if not exists export_audit (
  id text primary key,
  actor_user_id uuid null,
  export_type text not null,
  filters jsonb not null,
  created_at timestamp not null
);
