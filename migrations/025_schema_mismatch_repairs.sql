alter table if exists applications
  add column if not exists owner_user_id uuid;

alter table if exists applications
  add column if not exists name text;

alter table if exists idempotency_keys
  add column if not exists method text;

update idempotency_keys
set method = 'POST'
where method is null;

alter table if exists idempotency_keys
  alter column method set default 'POST';

alter table if exists idempotency_keys
  alter column method set not null;
