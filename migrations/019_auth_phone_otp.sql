alter table if exists users
  add column if not exists phone_number text;

alter table if exists users
  add column if not exists phone_verified boolean default false;

update users
set phone_number = '+' || regexp_replace(id::text, '-', '', 'g')
where phone_number is null;

alter table if exists users
  alter column phone_number set not null;

alter table if exists users
  add constraint users_phone_number_unique unique (phone_number);

alter table if exists users
  alter column email drop not null;

alter table if exists users
  alter column password_hash drop not null;
