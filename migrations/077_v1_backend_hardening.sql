create table if not exists borrowers (
  id uuid primary key,
  application_id text not null references applications(id) on delete cascade,
  company_name text not null,
  operating_name text null,
  entity_type text null,
  incorporation_date date null,
  country text null,
  province_state text null,
  industry text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (application_id)
);

create table if not exists owners (
  id uuid primary key,
  borrower_id uuid not null references borrowers(id) on delete cascade,
  name text not null,
  ownership_percentage numeric(6,2) null,
  email text null,
  phone text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_owners_borrower_id
  on owners (borrower_id);

create table if not exists financials (
  id uuid primary key,
  borrower_id uuid not null references borrowers(id) on delete cascade,
  annual_revenue numeric(14,2) null,
  time_in_business_months integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (borrower_id)
);

create table if not exists collateral (
  id uuid primary key,
  borrower_id uuid not null references borrowers(id) on delete cascade,
  accounts_receivable_value numeric(14,2) null,
  inventory_value numeric(14,2) null,
  equipment_value numeric(14,2) null,
  real_estate_value numeric(14,2) null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (borrower_id)
);

create table if not exists offers (
  id uuid primary key,
  application_id text not null references applications(id) on delete cascade,
  lender_submission_id text null references lender_submissions(id) on delete set null,
  lender_name text not null,
  amount numeric(14,2) null,
  rate_factor text null,
  term text null,
  payment_frequency text null,
  expiry_date date null,
  document_url text null,
  recommended boolean not null default false,
  status text not null default 'pending',
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offers_status_check check (status in ('pending','accepted','rejected','changes_requested'))
);

create index if not exists idx_offers_application_id
  on offers (application_id, created_at desc);

alter table if exists documents
  add column if not exists borrower_id uuid null,
  add column if not exists application_id text null,
  add column if not exists file_url text null,
  add column if not exists object_key text null,
  add column if not exists uploaded_at timestamptz null,
  add column if not exists signed_category text null,
  add column if not exists ocr_status text null;

update documents
set application_id = coalesce(documents.application_id, documents.application_id);

create index if not exists idx_documents_application_uploaded
  on documents (application_id, created_at desc);

create index if not exists idx_pwa_notifications_user_delivered
  on pwa_notifications (user_id, delivered_at desc);

create index if not exists idx_pwa_notifications_user_hash_time
  on pwa_notifications (user_id, payload_hash, delivered_at desc);
