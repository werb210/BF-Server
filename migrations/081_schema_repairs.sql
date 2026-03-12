create table if not exists password_resets (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now()
);

alter table if exists password_resets
  add column if not exists used_at timestamptz null,
  add column if not exists created_at timestamptz not null default now();

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
  add column if not exists id text,
  add column if not exists key text,
  add column if not exists route text,
  add column if not exists request_hash text,
  add column if not exists response_code integer,
  add column if not exists response_body jsonb,
  add column if not exists created_at timestamp not null default now();

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_name = 'idempotency_keys'
      and column_name = 'idempotency_key'
  ) and exists (
    select 1
    from information_schema.columns
    where table_name = 'idempotency_keys'
      and column_name = 'key'
  ) then
    execute 'update idempotency_keys set key = idempotency_key where key is null';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_name = 'idempotency_keys'
      and column_name = 'scope'
  ) and exists (
    select 1
    from information_schema.columns
    where table_name = 'idempotency_keys'
      and column_name = 'route'
  ) then
    execute 'update idempotency_keys set route = scope where route is null';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_name = 'idempotency_keys'
      and column_name = 'status_code'
  ) and exists (
    select 1
    from information_schema.columns
    where table_name = 'idempotency_keys'
      and column_name = 'response_code'
  ) then
    execute 'update idempotency_keys set response_code = status_code where response_code is null';
  end if;
end $$;

update idempotency_keys
set response_code = 200
where response_code is null;

update idempotency_keys
set request_hash = ''
where request_hash is null;

update idempotency_keys
set id = md5(
  coalesce(key, '') || ':' || coalesce(route, '') || ':' || coalesce(created_at::text, '') || ':' || random()::text
)
where id is null;

alter table if exists idempotency_keys
  alter column id set not null;

create unique index if not exists idempotency_keys_id_unique_idx
  on idempotency_keys (id);

alter table if exists applications
  add column if not exists owner_user_id uuid;
