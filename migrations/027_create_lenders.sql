create table if not exists lenders (
  id uuid primary key,
  name text not null,
  active boolean not null default true,
  phone text null,
  website text null,
  description text null,
  street text null,
  city text null,
  region text null,
  country text not null,
  postal_code text null,
  contact_name text null,
  contact_email text null,
  contact_phone text null,
  submission_method text null,
  submission_email text null,
  created_at timestamp not null default now()
);

alter table if exists lender_products
  drop constraint if exists lender_products_lender_id_fkey;

alter table if exists lenders
  alter column id type uuid using id::uuid;

alter table if exists lender_products
  alter column lender_id type uuid using lender_id::uuid;

alter table if exists lenders
  alter column phone drop not null,
  alter column active set default true,
  alter column created_at set default now();

alter table if exists lenders
  add column if not exists street text null,
  add column if not exists city text null,
  add column if not exists region text null,
  add column if not exists country text,
  add column if not exists postal_code text null,
  add column if not exists contact_name text null,
  add column if not exists contact_email text null,
  add column if not exists contact_phone text null,
  add column if not exists submission_method text null,
  add column if not exists submission_email text null;

update lenders
  set country = 'US'
  where country is null;

alter table if exists lenders
  alter column country set not null;

alter table if exists lenders
  add constraint lenders_name_unique unique (name);

alter table if exists lenders
  add constraint lenders_submission_method_check
  check (submission_method is null or submission_method in ('EMAIL', 'API'));

create index if not exists lenders_active_idx on lenders (active);

alter table if exists lender_products
  add constraint lender_products_lender_id_fkey
  foreign key (lender_id) references lenders(id) on delete cascade;
