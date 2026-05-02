-- BF_SERVER_BLOCK_v81_CATEGORIES_COMPANION (hotfix v81a)
-- Idempotent: safe to re-run after a previous failed application.
-- The previous version declared parent_application_id as UUID, but
-- applications.id is TEXT in production; the inline FK failed with
-- "Key columns ... are of incompatible types: uuid and text."

-- 1. Add parent_application_id with the SAME type as applications.id.
DO $$
DECLARE
  parent_type text;
BEGIN
  SELECT data_type INTO parent_type
    FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name   = 'applications'
     AND column_name  = 'id';

  IF parent_type IS NULL THEN
    RAISE EXCEPTION 'applications.id column not found — is the applications table missing?';
  END IF;

  -- Add the column if it doesn't exist, using the parent column's data type.
  -- For UUID parent we use UUID; for text/varchar parent we use TEXT.
  -- (Anything else is unexpected; default to TEXT which can store UUIDs as strings.)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name   = 'applications'
       AND column_name  = 'parent_application_id'
  ) THEN
    IF parent_type = 'uuid' THEN
      EXECUTE 'ALTER TABLE applications ADD COLUMN parent_application_id UUID';
    ELSE
      EXECUTE 'ALTER TABLE applications ADD COLUMN parent_application_id TEXT';
    END IF;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS applications_parent_application_id_idx
  ON applications(parent_application_id);

-- 2. Add the foreign-key constraint separately, idempotent. Both columns
-- now share the same type, so this succeeds.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'applications_parent_application_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE applications
        ADD CONSTRAINT applications_parent_application_id_fkey
        FOREIGN KEY (parent_application_id)
        REFERENCES applications(id) ON DELETE SET NULL;
    EXCEPTION WHEN feature_not_supported OR datatype_mismatch THEN
      RAISE NOTICE 'parent_application_id FK skipped — type mismatch with applications.id; column still usable as a soft reference.';
    END;
  END IF;
END$$;

-- 3. product_category column for application-level filtering.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS product_category TEXT;

-- 4. lender_products.category constraint — drop legacy, recreate with full
-- 10-category set. Idempotent; safe to re-run.
DO $$
BEGIN
  -- Drop any constraint we recognize, by any of its likely names.
  BEGIN
    ALTER TABLE lender_products DROP CONSTRAINT IF EXISTS lender_products_category_check;
  EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN
    ALTER TABLE lender_products DROP CONSTRAINT IF EXISTS lender_products_check_category;
  EXCEPTION WHEN OTHERS THEN NULL; END;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lender_products_category_check'
       AND conrelid = 'lender_products'::regclass
  ) THEN
    ALTER TABLE lender_products
      ADD CONSTRAINT lender_products_category_check
      CHECK (category IN ('LOC','TERM','FACTORING','PO','EQUIPMENT','MCA','MEDIA','ABL','SBA','STARTUP'));
  END IF;
END$$;

-- 5. Trace marker so the migration runner log shows successful application.
DO $$ BEGIN RAISE NOTICE 'BF_SERVER_BLOCK_v81_CATEGORIES_COMPANION (hotfix v81a) applied'; END $$;
