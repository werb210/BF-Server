create extension if not exists pgcrypto;

create table if not exists otp_codes (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code text not null,
  attempts int default 0,
  created_at timestamp not null default now(),
  expires_at timestamp not null,
  consumed boolean default false
);

alter table otp_codes
  alter column id set default gen_random_uuid(),
  add column if not exists attempts int default 0,
  add column if not exists consumed boolean default false;

create index if not exists idx_otp_phone on otp_codes (phone);
