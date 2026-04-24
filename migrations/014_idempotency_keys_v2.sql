drop table if exists idempotency_keys cascade;
drop index if exists idempotency_keys_pkey;

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

create index if not exists idempotency_keys_created_at_idx
  on idempotency_keys (created_at);
