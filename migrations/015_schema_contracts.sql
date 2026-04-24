alter table if exists users
  add column if not exists created_at timestamp not null default now(),
  add column if not exists updated_at timestamp not null default now();

alter table if exists users
  alter column password_changed_at drop not null;

alter table if exists applications
  add column if not exists status text not null default 'NEW';

update applications
set status = pipeline_state
where status is null;

alter table if exists documents
  add column if not exists version integer not null default 1,
  add column if not exists status text not null default 'uploaded';

create view refresh_tokens as
  select id, user_id, token_hash, expires_at, revoked_at
  from auth_refresh_tokens;
