-- ============================================================================
-- 042 - enum alignment
--
-- Normalises lenders.(country|submission_method|status) and
-- lender_products.(country|rate_type) to canonical enum types.
--
-- This migration is written to be safe regardless of whether these columns
-- are currently plain text, a pre-existing enum (e.g. lender_country from 041
-- or lender_status from 038), or already the target enum type from a previous
-- run. Every UPDATE is wrapped in a guard that only executes when the column
-- is text (UPPER'ing an enum value is a no-op, and assigning text back to an
-- enum column fails, so we skip the UPDATE when the column is already an
-- enum).
-- ============================================================================

-- Create target enum types if they do not exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lender_country_enum') THEN
    CREATE TYPE lender_country_enum AS ENUM ('CA', 'US', 'BOTH');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'submission_method_enum') THEN
    CREATE TYPE submission_method_enum AS ENUM ('EMAIL', 'API');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lender_status_enum') THEN
    CREATE TYPE lender_status_enum AS ENUM ('ACTIVE', 'INACTIVE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'product_country_enum') THEN
    CREATE TYPE product_country_enum AS ENUM ('CA', 'US', 'BOTH');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rate_type_enum') THEN
    CREATE TYPE rate_type_enum AS ENUM ('FIXED', 'VARIABLE');
  END IF;
END $$;

-- Normalise text values to upper-case ONLY when columns are still plain text.
-- If a column is already an enum, its values are by definition valid enum
-- labels and no normalisation is needed.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT udt_name INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'lenders' AND column_name = 'country';
  IF col_type = 'text' THEN
    UPDATE lenders SET country = UPPER(country) WHERE country IS NOT NULL;
  END IF;

  SELECT udt_name INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'lenders' AND column_name = 'submission_method';
  IF col_type = 'text' THEN
    UPDATE lenders SET submission_method = UPPER(submission_method) WHERE submission_method IS NOT NULL;
  END IF;

  SELECT udt_name INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'lenders' AND column_name = 'status';
  IF col_type = 'text' THEN
    UPDATE lenders SET status = UPPER(status) WHERE status IS NOT NULL;
  END IF;

  SELECT udt_name INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'lender_products' AND column_name = 'country';
  IF col_type = 'text' THEN
    UPDATE lender_products SET country = UPPER(country) WHERE country IS NOT NULL;
  END IF;

  SELECT udt_name INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'lender_products' AND column_name = 'rate_type';
  IF col_type = 'text' THEN
    UPDATE lender_products SET rate_type = UPPER(rate_type) WHERE rate_type IS NOT NULL;
  END IF;
END $$;

-- Add PORTAL and MANUAL enum values if missing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'submission_method_enum') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'submission_method_enum' AND e.enumlabel = 'PORTAL'
    ) THEN
      ALTER TYPE submission_method_enum ADD VALUE 'PORTAL';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'submission_method_enum' AND e.enumlabel = 'MANUAL'
    ) THEN
      ALTER TYPE submission_method_enum ADD VALUE 'MANUAL';
    END IF;
  END IF;
END $$;

-- Force invalid submission_method text values to EMAIL (only if still text).
DO $$
DECLARE col_type text;
BEGIN
  SELECT udt_name INTO col_type FROM information_schema.columns
  WHERE table_name = 'lenders' AND column_name = 'submission_method';
  IF col_type = 'text' THEN
    UPDATE lenders SET submission_method = 'EMAIL'
    WHERE submission_method IS NULL OR submission_method NOT IN ('EMAIL','API','PORTAL','MANUAL');
  END IF;
END $$;

-- Before converting columns to enum types, drop any CHECK constraints that
-- compare these columns to text literals. Postgres revalidates CHECK
-- constraints when a column's type changes, and an existing constraint like
-- `submission_method = ANY (ARRAY['EMAIL'::text, ...])` will fail after
-- the column becomes an enum (no operator between enum and text). We
-- re-add canonical constraints at the end of this migration.
ALTER TABLE lenders         DROP CONSTRAINT IF EXISTS lenders_submission_method_check;
ALTER TABLE lenders         DROP CONSTRAINT IF EXISTS lenders_country_check;
ALTER TABLE lenders         DROP CONSTRAINT IF EXISTS lenders_status_check;
ALTER TABLE lenders         DROP CONSTRAINT IF EXISTS lenders_active_status_check;
ALTER TABLE lender_products DROP CONSTRAINT IF EXISTS lender_products_country_check;
ALTER TABLE lender_products DROP CONSTRAINT IF EXISTS lender_products_rate_type_check;
ALTER TABLE lender_products DROP CONSTRAINT IF EXISTS lender_products_variable_rate_check;

-- Convert columns to target enum types, but only if they are not already the
-- target type (ALTER COLUMN TYPE to same type with a USING clause can fail).
DO $$
DECLARE col_type text;
BEGIN
  SELECT udt_name INTO col_type FROM information_schema.columns
  WHERE table_name = 'lenders' AND column_name = 'country';
  IF col_type <> 'lender_country_enum' THEN
    EXECUTE 'ALTER TABLE lenders ALTER COLUMN country TYPE lender_country_enum USING UPPER(country::text)::lender_country_enum';
  END IF;

  SELECT udt_name INTO col_type FROM information_schema.columns
  WHERE table_name = 'lenders' AND column_name = 'submission_method';
  IF col_type <> 'submission_method_enum' THEN
    EXECUTE 'ALTER TABLE lenders ALTER COLUMN submission_method TYPE submission_method_enum USING UPPER(submission_method::text)::submission_method_enum';
  END IF;

  SELECT udt_name INTO col_type FROM information_schema.columns
  WHERE table_name = 'lenders' AND column_name = 'status';
  IF col_type <> 'lender_status_enum' THEN
    EXECUTE 'ALTER TABLE lenders ALTER COLUMN status DROP DEFAULT';
    EXECUTE 'ALTER TABLE lenders ALTER COLUMN status TYPE lender_status_enum USING UPPER(status::text)::lender_status_enum';
    EXECUTE 'ALTER TABLE lenders ALTER COLUMN status SET DEFAULT ''ACTIVE''::lender_status_enum';
  END IF;

  SELECT udt_name INTO col_type FROM information_schema.columns
  WHERE table_name = 'lender_products' AND column_name = 'country';
  IF col_type <> 'product_country_enum' THEN
    EXECUTE 'ALTER TABLE lender_products ALTER COLUMN country DROP DEFAULT';
    EXECUTE 'ALTER TABLE lender_products ALTER COLUMN country TYPE product_country_enum USING UPPER(country::text)::product_country_enum';
    EXECUTE 'ALTER TABLE lender_products ALTER COLUMN country SET DEFAULT ''BOTH''::product_country_enum';
  END IF;

  SELECT udt_name INTO col_type FROM information_schema.columns
  WHERE table_name = 'lender_products' AND column_name = 'rate_type';
  IF col_type <> 'rate_type_enum' THEN
    EXECUTE 'ALTER TABLE lender_products ALTER COLUMN rate_type TYPE rate_type_enum USING UPPER(rate_type::text)::rate_type_enum';
  END IF;
END $$;

-- Rebuild the variable_rate CHECK constraint. Use ::text casts so the check
-- works whether rate_type ends up as an enum or remains text in some branch.
ALTER TABLE lender_products DROP CONSTRAINT IF EXISTS lender_products_variable_rate_check;
ALTER TABLE lender_products
  ADD CONSTRAINT lender_products_variable_rate_check
  CHECK (
    rate_type::text IS DISTINCT FROM 'VARIABLE'
    OR (
      interest_min IS NOT NULL
      AND interest_max IS NOT NULL
      AND (interest_min ILIKE 'P+%' OR interest_min ILIKE 'Prime + %')
      AND (interest_max ILIKE 'P+%' OR interest_max ILIKE 'Prime + %')
    )
  );

-- Rebuild the submission_method CHECK constraint.
ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_submission_method_check;

DO $$
DECLARE col_type text;
BEGIN
  SELECT udt_name INTO col_type FROM information_schema.columns
  WHERE table_name = 'lenders' AND column_name = 'submission_method';
  IF col_type = 'text' THEN
    UPDATE lenders SET submission_method = 'EMAIL'
    WHERE submission_method IS NULL OR submission_method NOT IN ('EMAIL','API','PORTAL','MANUAL');
  END IF;
END $$;

ALTER TABLE lenders ADD CONSTRAINT lenders_submission_method_check
CHECK (submission_method::text IN ('EMAIL','API','PORTAL','MANUAL'));

-- Re-add lenders_active_status_check (we dropped it before the ALTER COLUMN
-- TYPE so constraint revalidation wouldn't fail with enum-vs-text operators).
-- Cast the literals to the column's current enum type so the check works
-- regardless of whether status is lender_status or lender_status_enum.
DO $$
DECLARE col_type text;
BEGIN
  SELECT udt_name INTO col_type FROM information_schema.columns
  WHERE table_name = 'lenders' AND column_name = 'status';
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'lenders' AND n.nspname = 'public'
      AND c.conname = 'lenders_active_status_check'
  ) THEN
    EXECUTE format(
      'ALTER TABLE lenders ADD CONSTRAINT lenders_active_status_check '
      'CHECK ((active = true AND status::text = ''ACTIVE'') OR '
      '       (active = false AND status::text = ''INACTIVE''))'
    );
  END IF;
END $$;
