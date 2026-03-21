alter table if exists lenders
  add column if not exists id text,
  add column if not exists name text,
  add column if not exists created_at timestamptz not null default now();

alter table if exists lender_products
  add column if not exists id text,
  add column if not exists lender_id text,
  add column if not exists name text,
  add column if not exists category text,
  add column if not exists min_amount integer,
  add column if not exists max_amount integer,
  add column if not exists created_at timestamptz not null default now();
