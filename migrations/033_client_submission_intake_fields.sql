alter table if exists applications
  add column if not exists lender_id uuid null,
  add column if not exists lender_product_id uuid null,
  add column if not exists requested_amount numeric null,
  add column if not exists source text null;
