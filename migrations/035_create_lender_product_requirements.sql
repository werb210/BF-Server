create table if not exists lender_product_requirements (
  id uuid primary key default gen_random_uuid(),
  lender_product_id text not null references lender_products(id) on delete cascade,
  document_type text not null,
  required boolean not null default true,
  min_amount integer null,
  max_amount integer null,
  created_at timestamptz not null default now()
);

create index if not exists lender_product_requirements_lender_product_id_idx
  on lender_product_requirements (lender_product_id);

create index if not exists lender_product_requirements_document_type_idx
  on lender_product_requirements (document_type);
