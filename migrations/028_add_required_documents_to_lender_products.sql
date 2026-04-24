alter table lender_products
  add column if not exists required_documents jsonb;
