alter table if exists users
  add column if not exists disabled boolean default false;

alter table if exists users
  add column if not exists is_active boolean;
