create table if not exists password_resets (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamp not null default now()
);

alter table if exists password_resets
  add column if not exists used_at timestamptz null,
  add column if not exists created_at timestamp not null default now();

create table if not exists idempotency_keys (
  id text primary key,
  key text not null,
  route text not null,
  request_hash text not null,
  response_code integer not null,
  response_body jsonb not null,
  created_at timestamp not null default now(),
  unique (key, route)
);

alter table if exists idempotency_keys
  add column if not exists id text;

update idempotency_keys
set id = md5(key || ':' || route)
where id is null;

alter table if exists idempotency_keys
  alter column id set not null;

create unique index if not exists idempotency_keys_id_unique_idx
  on idempotency_keys (id);

alter table if exists audit_events
  add column if not exists actor_user_id uuid null references users(id) on delete set null;

alter table if exists audit_events
  add column if not exists target_user_id uuid null references users(id) on delete set null;

alter table if exists audit_events
  add column if not exists target_type text null;

alter table if exists audit_events
  add column if not exists target_id text null;

alter table if exists audit_events
  add column if not exists event_type text null;

alter table if exists audit_events
  add column if not exists event_action text null;

alter table if exists audit_events
  add column if not exists ip_address text null;

alter table if exists audit_events
  add column if not exists user_agent text null;

alter table if exists audit_events
  add column if not exists request_id text null;

alter table if exists audit_events
  add column if not exists metadata jsonb null;

alter table if exists audit_events
  alter column action drop not null;

create sequence if not exists audit_events_id_seq;

alter table if exists audit_events
  alter column id set default nextval('audit_events_id_seq')::text;

alter table if exists audit_events
  alter column created_at set default now();

alter table if exists applications
  add column if not exists owner_user_id uuid;
