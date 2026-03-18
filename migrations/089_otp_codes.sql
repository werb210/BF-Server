create table if not exists otp_codes (
  id uuid primary key,
  phone text not null,
  code text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists otp_codes_phone_idx on otp_codes (phone);
