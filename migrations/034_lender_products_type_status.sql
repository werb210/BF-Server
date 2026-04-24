ALTER TABLE lender_products
  ADD COLUMN IF NOT EXISTS lender_name TEXT,
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS min_amount INTEGER,
  ADD COLUMN IF NOT EXISTS max_amount INTEGER,
  ADD COLUMN IF NOT EXISTS status TEXT;

UPDATE lender_products
SET
  type = COALESCE(type, 'loc'),
  status = COALESCE(status, 'active'),
  lender_name = COALESCE(lender_name, '');

ALTER TABLE lender_products
  ALTER COLUMN lender_name SET NOT NULL,
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN status SET NOT NULL;
