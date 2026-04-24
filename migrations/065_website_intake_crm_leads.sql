create table if not exists crm_leads (
  id uuid primary key,
  company_name text null,
  full_name text null,
  phone text null,
  email text not null,
  industry text null,
  years_in_business text null,
  monthly_revenue text null,
  annual_revenue text null,
  ar_outstanding text null,
  existing_debt text null,
  notes text null,
  source text not null,
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table if exists crm_leads add column if not exists id uuid;
alter table if exists crm_leads add column if not exists company_name text;
alter table if exists crm_leads add column if not exists full_name text;
alter table if exists crm_leads add column if not exists phone text;
alter table if exists crm_leads add column if not exists email text;
alter table if exists crm_leads add column if not exists industry text;
alter table if exists crm_leads add column if not exists years_in_business text;
alter table if exists crm_leads add column if not exists monthly_revenue text;
alter table if exists crm_leads add column if not exists annual_revenue text;
alter table if exists crm_leads add column if not exists ar_outstanding text;
alter table if exists crm_leads add column if not exists existing_debt text;
alter table if exists crm_leads add column if not exists notes text;
alter table if exists crm_leads add column if not exists source text;
alter table if exists crm_leads add column if not exists tags jsonb not null default '[]'::jsonb;
alter table if exists crm_leads add column if not exists created_at timestamptz not null default now();

update crm_leads
set source = case when source is null or source = '' then 'website' else source end
where source is null or source = '';

alter table if exists crm_leads alter column source set not null;

create unique index if not exists idx_crm_leads_id on crm_leads(id);
create index if not exists idx_crm_leads_source on crm_leads(source);
create index if not exists idx_crm_leads_created_at on crm_leads(created_at desc);
