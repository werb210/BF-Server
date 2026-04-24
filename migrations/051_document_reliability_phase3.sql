alter table if exists applications
  add column if not exists ocr_missing_fields jsonb null,
  add column if not exists ocr_conflicting_fields jsonb null,
  add column if not exists ocr_normalized_values jsonb null,
  add column if not exists ocr_has_missing_fields boolean not null default false,
  add column if not exists ocr_has_conflicts boolean not null default false,
  add column if not exists ocr_insights_updated_at timestamptz null;

create table if not exists notifications (
  id uuid primary key,
  user_id uuid null references users(id) on delete set null,
  application_id text null references applications(id) on delete set null,
  type text not null,
  title text not null,
  body text not null,
  metadata jsonb null,
  created_at timestamptz not null default now(),
  read_at timestamptz null
);

create table if not exists companies (
  id uuid primary key,
  name text null,
  website text null,
  email text null,
  phone text null,
  status text not null default 'prospect',
  owner_id uuid null references users(id) on delete set null,
  referrer_id uuid null references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists contacts (
  id uuid primary key,
  company_id uuid null references companies(id) on delete set null,
  name text null,
  email text null,
  phone text null,
  status text not null default 'prospect',
  owner_id uuid null references users(id) on delete set null,
  referrer_id uuid null references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists companies
  add column if not exists website text null,
  add column if not exists status text not null default 'prospect',
  add column if not exists owner_id uuid null,
  add column if not exists referrer_id uuid null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists contacts
  add column if not exists name text null,
  add column if not exists status text not null default 'prospect',
  add column if not exists owner_id uuid null,
  add column if not exists referrer_id uuid null,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();
