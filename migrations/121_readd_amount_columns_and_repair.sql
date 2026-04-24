-- 121_readd_amount_columns_and_repair.sql
-- Re-add amount_min / amount_max on lender_products (dropped by 041).
-- Also backfills from seed IDs if they exist. Fully idempotent.

ALTER TABLE lender_products
  ADD COLUMN IF NOT EXISTS amount_min BIGINT,
  ADD COLUMN IF NOT EXISTS amount_max BIGINT;

-- Backfill amount ranges for the Boreal Direct seed rows if they exist
-- (we do this unconditionally with UPDATE...WHERE so it's safe on any schema state)
UPDATE lender_products SET amount_min = 25000,  amount_max = 500000   WHERE id = '33333333-3333-3333-3333-333333333301' AND (amount_min IS NULL OR amount_max IS NULL);
UPDATE lender_products SET amount_min = 50000,  amount_max = 1000000  WHERE id = '33333333-3333-3333-3333-333333333302' AND (amount_min IS NULL OR amount_max IS NULL);
UPDATE lender_products SET amount_min = 10000,  amount_max = 500000   WHERE id = '33333333-3333-3333-3333-333333333303' AND (amount_min IS NULL OR amount_max IS NULL);
UPDATE lender_products SET amount_min = 10000,  amount_max = 250000   WHERE id = '33333333-3333-3333-3333-333333333304' AND (amount_min IS NULL OR amount_max IS NULL);
UPDATE lender_products SET amount_min = 25000,  amount_max = 2000000  WHERE id = '33333333-3333-3333-3333-333333333305' AND (amount_min IS NULL OR amount_max IS NULL);
UPDATE lender_products SET amount_min = 5000,   amount_max = 200000   WHERE id = '33333333-3333-3333-3333-333333333306' AND (amount_min IS NULL OR amount_max IS NULL);
UPDATE lender_products SET amount_min = 25000,  amount_max = 1000000  WHERE id = '33333333-3333-3333-3333-333333333307' AND (amount_min IS NULL OR amount_max IS NULL);
UPDATE lender_products SET amount_min = 50000,  amount_max = 750000   WHERE id = '44444444-4444-4444-4444-444444444401' AND (amount_min IS NULL OR amount_max IS NULL);
UPDATE lender_products SET amount_min = 100000, amount_max = 2000000  WHERE id = '44444444-4444-4444-4444-444444444402' AND (amount_min IS NULL OR amount_max IS NULL);
UPDATE lender_products SET amount_min = 50000,  amount_max = 5000000  WHERE id = '44444444-4444-4444-4444-444444444403' AND (amount_min IS NULL OR amount_max IS NULL);

-- Ensure a single migration-tracking table exists with a PK so runs are idempotent
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- If an older applied_migrations table exists, mirror its contents over
-- so we can converge on schema_migrations as the single source of truth.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'applied_migrations') THEN
    INSERT INTO schema_migrations (id, applied_at)
      SELECT id, COALESCE(applied_at, now()) FROM applied_migrations
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
