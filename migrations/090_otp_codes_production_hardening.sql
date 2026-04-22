create table if not exists otp_codes (
  id uuid primary key,
  phone text not null,
  code text not null,
  attempts int default 0,
  created_at timestamp not null default now(),
  expires_at timestamp not null,
  consumed boolean default false
);

alter table otp_codes
  add column if not exists attempts int default 0,
  add column if not exists consumed boolean default false;

do $$
begin
  if exists (
    select 1
    from pg_proc
    where proname = 'uuid_generate_v4'
  ) then
    alter table otp_codes alter column id set default uuid_generate_v4();
  else
    alter table otp_codes alter column id drop default;
  end if;
end $$;

create index if not exists idx_otp_phone on otp_codes (phone);
