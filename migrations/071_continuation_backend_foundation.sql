create table if not exists continuation (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  full_name text not null,
  email text not null,
  phone text not null,
  industry text not null,
  years_in_business text,
  monthly_revenue text,
  annual_revenue text,
  ar_outstanding text,
  existing_debt text,
  used_in_application boolean default false,
  created_at timestamp default now()
);

create index if not exists idx_continuation_email_created_at
  on continuation (email, created_at desc);
