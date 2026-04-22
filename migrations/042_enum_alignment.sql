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

UPDATE lenders
SET country = UPPER(country::text)
WHERE country IS NOT NULL;

UPDATE lenders
SET submission_method = UPPER(submission_method::text)
WHERE submission_method IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'submission_method_enum') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'submission_method_enum'
        AND e.enumlabel = 'PORTAL'
    ) THEN
      ALTER TYPE submission_method_enum ADD VALUE 'PORTAL';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'submission_method_enum'
        AND e.enumlabel = 'MANUAL'
    ) THEN
      ALTER TYPE submission_method_enum ADD VALUE 'MANUAL';
    END IF;
  END IF;
END $$;

UPDATE lenders
SET submission_method = 'EMAIL'
WHERE submission_method IS NULL OR submission_method::text NOT IN ('EMAIL','API','PORTAL','MANUAL');

UPDATE lenders
SET status = UPPER(status::text)
WHERE status IS NOT NULL;

ALTER TABLE lenders
  ALTER COLUMN country TYPE lender_country_enum USING UPPER(country::text)::lender_country_enum,
  ALTER COLUMN submission_method TYPE submission_method_enum USING UPPER(submission_method::text)::submission_method_enum,
  ALTER COLUMN status TYPE lender_status_enum USING UPPER(status::text)::lender_status_enum,
  ALTER COLUMN status SET DEFAULT 'ACTIVE';

UPDATE lender_products
SET country = UPPER(country::text)
WHERE country IS NOT NULL;

UPDATE lender_products
SET rate_type = UPPER(rate_type::text)
WHERE rate_type IS NOT NULL;

ALTER TABLE lender_products
  ALTER COLUMN country TYPE product_country_enum USING UPPER(country::text)::product_country_enum,
  ALTER COLUMN rate_type TYPE rate_type_enum USING UPPER(rate_type::text)::rate_type_enum;

ALTER TABLE lender_products
  DROP CONSTRAINT IF EXISTS lender_products_variable_rate_check;

ALTER TABLE lender_products
  ADD CONSTRAINT lender_products_variable_rate_check
  CHECK (
    rate_type IS DISTINCT FROM 'VARIABLE'
    OR (
      interest_min IS NOT NULL
      AND interest_max IS NOT NULL
      AND (
        interest_min ILIKE 'P+%' OR interest_min ILIKE 'Prime + %'
      )
      AND (
        interest_max ILIKE 'P+%' OR interest_max ILIKE 'Prime + %'
      )
    )
  );

ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_submission_method_check;

UPDATE lenders
SET submission_method = 'EMAIL'
WHERE submission_method IS NULL OR submission_method::text NOT IN ('EMAIL','API','PORTAL','MANUAL');

ALTER TABLE lenders ADD CONSTRAINT lenders_submission_method_check
CHECK (submission_method IN ('EMAIL','API','PORTAL','MANUAL'));
