create table if not exists lenders (
  id text primary key,
  name text not null,
  phone text not null,
  website text null,
  description text null,
  active boolean not null default true,
  created_at timestamp not null,
  updated_at timestamp not null
);

create table if not exists lender_products (
  id text primary key,
  lender_id text not null references lenders(id) on delete cascade,
  name text not null,
  description text null,
  active boolean not null default true,
  created_at timestamp not null,
  updated_at timestamp not null
);
