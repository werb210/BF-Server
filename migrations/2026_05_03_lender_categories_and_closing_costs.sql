-- BF_SERVER_BLOCK_v81_CATEGORIES_COMPANION
-- Idempotent: safe to re-run.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS parent_application_id UUID
    REFERENCES applications(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS applications_parent_application_id_idx
  ON applications(parent_application_id);

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS product_category TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'lender_products'::regclass
      AND conname IN ('lender_products_category_check', 'lender_products_check_category')
  ) THEN
    BEGIN
      ALTER TABLE lender_products DROP CONSTRAINT IF EXISTS lender_products_category_check;
    EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN
      ALTER TABLE lender_products DROP CONSTRAINT IF EXISTS lender_products_check_category;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
END$$;

ALTER TABLE lender_products
  ADD CONSTRAINT lender_products_category_check
  CHECK (category IN ('LOC','TERM','FACTORING','PO','EQUIPMENT','MCA','MEDIA','ABL','SBA','STARTUP'));

DO $$ BEGIN RAISE NOTICE 'BF_SERVER_BLOCK_v81_CATEGORIES_COMPANION applied'; END $$;
