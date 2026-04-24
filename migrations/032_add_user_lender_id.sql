alter table users
  add column if not exists lender_id uuid null;
