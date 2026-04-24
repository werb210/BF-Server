-- Ensure user_status enum contains only ACTIVE/INACTIVE
DO $$
DECLARE
  column_record record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status_new') THEN
      CREATE TYPE user_status_new AS ENUM ('ACTIVE', 'INACTIVE');
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'users'
        AND column_name = 'status'
    ) THEN
      UPDATE users SET status = 'INACTIVE' WHERE status::text = 'disabled';
    END IF;

    FOR column_record IN
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE udt_name = 'user_status'
    LOOP
      EXECUTE format(
        'ALTER TABLE %I.%I ALTER COLUMN %I TYPE user_status_new USING (CASE WHEN %I::text = ''disabled'' THEN ''INACTIVE'' ELSE %I::text END)::user_status_new',
        column_record.table_schema,
        column_record.table_name,
        column_record.column_name,
        column_record.column_name,
        column_record.column_name
      );
    END LOOP;

    DROP TYPE user_status;
    ALTER TYPE user_status_new RENAME TO user_status;
  ELSE
    CREATE TYPE user_status AS ENUM ('ACTIVE', 'INACTIVE');
  END IF;
END $$;

UPDATE users SET status = 'INACTIVE' WHERE status::text = 'disabled';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lender_country') THEN
    CREATE TYPE lender_country AS ENUM ('CA', 'US', 'BOTH');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lender_status') THEN
    CREATE TYPE lender_status AS ENUM ('ACTIVE', 'INACTIVE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lender_submission_method') THEN
    CREATE TYPE lender_submission_method AS ENUM ('EMAIL', 'API');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lender_product_category') THEN
    CREATE TYPE lender_product_category AS ENUM ('LOC', 'TERM', 'FACTORING', 'PO', 'EQUIPMENT', 'MCA');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lender_product_rate_type') THEN
    CREATE TYPE lender_product_rate_type AS ENUM ('FIXED', 'VARIABLE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lender_product_term_unit') THEN
    CREATE TYPE lender_product_term_unit AS ENUM ('MONTHS');
  END IF;
END $$;

-- Lenders table alignment
ALTER TABLE lenders
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS active BOOLEAN,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS submission_method TEXT,
  ADD COLUMN IF NOT EXISTS submission_email TEXT,
  ADD COLUMN IF NOT EXISTS api_config JSONB,
  ADD COLUMN IF NOT EXISTS primary_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS primary_contact_email TEXT,
  ADD COLUMN IF NOT EXISTS primary_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

UPDATE lenders
SET primary_contact_name = COALESCE(primary_contact_name, contact_name)
WHERE primary_contact_name IS NULL;

UPDATE lenders
SET primary_contact_email = COALESCE(primary_contact_email, contact_email)
WHERE primary_contact_email IS NULL;

UPDATE lenders
SET primary_contact_phone = COALESCE(primary_contact_phone, contact_phone)
WHERE primary_contact_phone IS NULL;

-- Drop any pre-existing CHECK constraints on columns we are about to normalize.
-- The UPDATEs below rewrite values (e.g. uppercasing submission_method,
-- normalizing country), and any old constraint whose allowed set no longer
-- matches the rewritten values will reject the UPDATE. Dropping the
-- constraints first lets the UPDATEs succeed; we re-add the canonical
-- constraints later in this migration.
ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_submission_method_check;
ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_country_check;
ALTER TABLE lenders DROP CONSTRAINT IF EXISTS lenders_status_check;

UPDATE lenders
SET country = CASE
  WHEN country IS NULL THEN 'BOTH'
  WHEN UPPER(country::text) = 'CA_US' THEN 'BOTH'
  WHEN UPPER(country::text) IN ('CA', 'US', 'BOTH') THEN UPPER(country::text)
  ELSE 'BOTH'
END;

UPDATE lenders
SET submission_method = COALESCE(UPPER(submission_method::text), 'EMAIL');

UPDATE lenders
SET submission_method = 'EMAIL'
WHERE submission_method IS NULL OR UPPER(submission_method::text) NOT IN ('EMAIL', 'API');

ALTER TABLE lenders
  DROP CONSTRAINT IF EXISTS lenders_submission_method_check;

UPDATE lenders
SET active = COALESCE(active, CASE WHEN status::text = 'INACTIVE' THEN FALSE ELSE TRUE END);

-- status and country may already be enum types from an earlier migration (e.g. 038).
-- Cast the text expression to the column's current type so this UPDATE works
-- whether the column is text or already an enum.
UPDATE lenders
SET status = (CASE WHEN active THEN 'ACTIVE'::lender_status ELSE 'INACTIVE'::lender_status END);

UPDATE lenders
SET created_at = COALESCE(created_at, now());

UPDATE lenders
SET updated_at = COALESCE(updated_at, created_at, now());

-- Drop any FKs that reference lenders.id before changing its type from text to uuid.
-- These are re-added by later migrations or after the lender_products block below.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname, conrelid::regclass AS tbl
    FROM pg_constraint
    WHERE confrelid = 'lenders'::regclass
      AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE lenders
  ALTER COLUMN id TYPE uuid USING id::uuid,
  ALTER COLUMN country TYPE lender_country USING UPPER(country::text)::lender_country,
  ALTER COLUMN status TYPE lender_status USING UPPER(status::text)::lender_status,
  ALTER COLUMN active SET DEFAULT TRUE,
  ALTER COLUMN active SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE lenders
  DROP CONSTRAINT IF EXISTS lenders_submission_method_check;

ALTER TABLE lenders
  ADD CONSTRAINT lenders_submission_method_check
  CHECK (submission_method IN ('EMAIL', 'API'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'lenders'
      AND n.nspname = 'public'
      AND c.conname = 'lenders_active_status_check'
  ) THEN
    ALTER TABLE lenders
      ADD CONSTRAINT lenders_active_status_check
      CHECK ((active = true AND status = 'ACTIVE') OR (active = false AND status = 'INACTIVE'));
  END IF;
END $$;

ALTER TABLE lenders
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS street,
  DROP COLUMN IF EXISTS city,
  DROP COLUMN IF EXISTS region,
  DROP COLUMN IF EXISTS postal_code,
  DROP COLUMN IF EXISTS contact_name,
  DROP COLUMN IF EXISTS contact_email,
  DROP COLUMN IF EXISTS contact_phone,
  DROP COLUMN IF EXISTS silo;

-- Lender products table alignment
ALTER TABLE lender_products
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS rate_type TEXT,
  ADD COLUMN IF NOT EXISTS interest_min TEXT,
  ADD COLUMN IF NOT EXISTS interest_max TEXT,
  ADD COLUMN IF NOT EXISTS term_min INTEGER,
  ADD COLUMN IF NOT EXISTS term_max INTEGER,
  ADD COLUMN IF NOT EXISTS term_unit TEXT,
  ADD COLUMN IF NOT EXISTS active BOOLEAN,
  ADD COLUMN IF NOT EXISTS required_documents JSONB,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

UPDATE lender_products
SET category = CASE
  WHEN category IS NOT NULL THEN category
  WHEN type IS NULL THEN 'LOC'
  WHEN UPPER(type::text) IN ('LOC', 'LINE_OF_CREDIT', 'STANDARD') THEN 'LOC'
  WHEN UPPER(type::text) IN ('TERM', 'TERM_LOAN') THEN 'TERM'
  WHEN UPPER(type::text) = 'FACTORING' THEN 'FACTORING'
  WHEN UPPER(type::text) IN ('PO', 'PURCHASE_ORDER') THEN 'PO'
  WHEN UPPER(type::text) IN ('EQUIPMENT', 'EQUIPMENT_FINANCING') THEN 'EQUIPMENT'
  WHEN UPPER(type::text) IN ('MCA', 'MERCHANT_CASH_ADVANCE') THEN 'MCA'
  ELSE 'LOC'
END;

UPDATE lender_products
SET country = CASE
  WHEN country IS NULL THEN 'BOTH'
  WHEN UPPER(country::text) = 'CA_US' THEN 'BOTH'
  WHEN UPPER(country::text) IN ('CA', 'US', 'BOTH') THEN UPPER(country::text)
  ELSE 'BOTH'
END;

UPDATE lender_products
SET rate_type = UPPER(rate_type::text)
WHERE rate_type IS NOT NULL;

UPDATE lender_products
SET interest_min = CASE
    WHEN UPPER(rate_type::text) = 'VARIABLE' THEN 'P+'
    ELSE COALESCE(interest_min, min_rate)
  END,
  interest_max = CASE
    WHEN UPPER(rate_type::text) = 'VARIABLE' THEN 'P+'
    ELSE COALESCE(interest_max, max_rate)
  END;

UPDATE lender_products
SET active = COALESCE(active, CASE WHEN status::text = 'inactive' THEN FALSE ELSE TRUE END);

UPDATE lender_products
SET required_documents = COALESCE(required_documents, '[]'::jsonb);

UPDATE lender_products
SET term_unit = COALESCE(term_unit, 'MONTHS');

UPDATE lender_products
SET created_at = COALESCE(created_at, now());

UPDATE lender_products
SET updated_at = COALESCE(updated_at, created_at, now());

-- Drop any text defaults on columns we are about to convert to enum types.
-- Postgres cannot auto-cast a text default (e.g. 'MONTHS') to an enum type.
ALTER TABLE lender_products
  ALTER COLUMN category  DROP DEFAULT,
  ALTER COLUMN country   DROP DEFAULT,
  ALTER COLUMN rate_type DROP DEFAULT,
  ALTER COLUMN term_unit DROP DEFAULT;

ALTER TABLE lender_products
  ALTER COLUMN id TYPE uuid USING id::uuid,
  ALTER COLUMN lender_id TYPE uuid USING lender_id::uuid,
  ALTER COLUMN category TYPE lender_product_category USING UPPER(category::text)::lender_product_category,
  ALTER COLUMN country TYPE lender_country USING UPPER(country::text)::lender_country,
  ALTER COLUMN rate_type TYPE lender_product_rate_type USING UPPER(rate_type::text)::lender_product_rate_type,
  ALTER COLUMN term_unit TYPE lender_product_term_unit USING UPPER(term_unit::text)::lender_product_term_unit,
  ALTER COLUMN active SET DEFAULT TRUE,
  ALTER COLUMN active SET NOT NULL,
  ALTER COLUMN category SET NOT NULL,
  ALTER COLUMN country SET NOT NULL,
  ALTER COLUMN term_unit SET NOT NULL,
  ALTER COLUMN required_documents SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

-- Re-add enum-typed defaults now that the columns are the right type.
ALTER TABLE lender_products
  ALTER COLUMN category  SET DEFAULT 'LOC'::lender_product_category,
  ALTER COLUMN term_unit SET DEFAULT 'MONTHS'::lender_product_term_unit;

-- Re-add FK lender_products.lender_id -> lenders.id now that both are uuid.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'lender_products'::regclass
      AND confrelid = 'lenders'::regclass
      AND contype = 'f'
  ) THEN
    ALTER TABLE lender_products
      ADD CONSTRAINT lender_products_lender_id_fkey
      FOREIGN KEY (lender_id) REFERENCES lenders(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'lender_products'
      AND n.nspname = 'public'
      AND c.conname = 'lender_products_variable_rate_check'
  ) THEN
    ALTER TABLE lender_products
      ADD CONSTRAINT lender_products_variable_rate_check
      CHECK (rate_type IS DISTINCT FROM 'VARIABLE' OR (interest_min = 'P+' AND interest_max = 'P+'));
  END IF;
END $$;

ALTER TABLE lender_products
  DROP COLUMN IF EXISTS lender_name,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS type,
  DROP COLUMN IF EXISTS min_amount,
  DROP COLUMN IF EXISTS max_amount,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS min_rate,
  DROP COLUMN IF EXISTS max_rate,
  DROP COLUMN IF EXISTS eligibility,
  DROP COLUMN IF EXISTS currency;

CREATE OR REPLACE FUNCTION enforce_active_lender_for_products()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM lenders
    WHERE id = NEW.lender_id
      AND active = true
  ) THEN
    RAISE EXCEPTION 'Lender must be active to assign products.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lender_products_active_lender_check ON lender_products;

CREATE TRIGGER lender_products_active_lender_check
BEFORE INSERT OR UPDATE OF lender_id ON lender_products
FOR EACH ROW
EXECUTE FUNCTION enforce_active_lender_for_products();
