create table if not exists pre_applications (
  id uuid primary key default gen_random_uuid(),
  company_name text,
  full_name text,
  email text,
  phone text,
  years_in_business text,
  annual_revenue text,
  monthly_revenue text,
  requested_amount text,
  credit_score_range text,
  ai_score text,
  consumed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_pre_applications_created_at
  on pre_applications (created_at desc);
