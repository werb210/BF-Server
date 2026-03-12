UPDATE users
SET status = 'INACTIVE'
WHERE status::text = 'disabled';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'users'
      AND n.nspname = 'public'
      AND c.conname = 'users_status_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_status_check
      CHECK (status in ('ACTIVE', 'INACTIVE'));
  END IF;
END $$;

UPDATE lenders
SET active = COALESCE(active, CASE WHEN status::text = 'INACTIVE' THEN false ELSE true END);

ALTER TABLE lenders
  ALTER COLUMN active SET DEFAULT true;

ALTER TABLE lenders
  ALTER COLUMN active SET NOT NULL;

UPDATE lender_products
SET active = COALESCE(active, true);

ALTER TABLE lender_products
  ALTER COLUMN active SET DEFAULT true;

ALTER TABLE lender_products
  ALTER COLUMN active SET NOT NULL;
