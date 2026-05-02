-- BF_SERVER_BLOCK_v81_CATEGORIES_COMPANION (hotfix v81b)
-- Idempotent. Safe to re-run after any combination of v81 / v81a having
-- been partially applied.
--
-- v81a added the FK type-aware column; this version (v81b) adds:
--   - normalize lender_products.category from old long vocabulary to
--     new short vocabulary BEFORE adding the CHECK constraint
--   - quarantine column for any unrecognized value, so we don't lose data

-- =====================================================================
-- Section 1 — applications.parent_application_id (unchanged from v81a)
-- =====================================================================
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
    RAISE EXCEPTION 'applications.id column not found';
  END IF;

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
      RAISE NOTICE 'parent_application_id FK skipped — type mismatch with applications.id';
    END;
  END IF;
END$$;

-- =====================================================================
-- Section 2 — applications.product_category (unchanged)
-- =====================================================================
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS product_category TEXT;

-- =====================================================================
-- Section 3 — lender_products.category NORMALIZATION
-- =====================================================================

-- 3a. Drop any prior version of the constraint we recognize.
DO $$
BEGIN
  BEGIN ALTER TABLE lender_products DROP CONSTRAINT IF EXISTS lender_products_category_check;
        EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE lender_products DROP CONSTRAINT IF EXISTS lender_products_check_category;
        EXCEPTION WHEN OTHERS THEN NULL; END;
END$$;

-- 3b. Add a quarantine column so we never lose the original value.
ALTER TABLE lender_products
  ADD COLUMN IF NOT EXISTS category_legacy TEXT;

-- 3c. Snapshot the BEFORE-state for audit. NOTICE-emit how many rows
-- per distinct value we're about to normalize.
DO $$
DECLARE
  r record;
  total int;
BEGIN
  SELECT count(*) INTO total FROM lender_products;
  RAISE NOTICE 'v81b normalization: % total lender_products rows', total;

  FOR r IN
    SELECT COALESCE(NULLIF(TRIM(category), ''), '<null>') AS cat, count(*) AS n
      FROM lender_products
     GROUP BY 1
     ORDER BY 2 DESC
  LOOP
    RAISE NOTICE 'v81b before-state: category=% count=%', r.cat, r.n;
  END LOOP;
END$$;

-- 3d. Capture the ORIGINAL category into category_legacy on first
-- normalization run. Only fill rows where category_legacy is still NULL,
-- so a re-run doesn't overwrite the audit trail with normalized values.
UPDATE lender_products
   SET category_legacy = category
 WHERE category_legacy IS NULL;

-- 3e. Normalize. Maps cover every value seen historically:
--   - long form portal labels (LINE_OF_CREDIT, TERM_LOAN, ...)
--   - short form server labels (LOC, TERM, ...) — already correct, no-op
--   - lower-case / mixed-case variants
--   - common synonyms (RLOC, REVOLVER for line of credit; INVOICE_FACTORING
--     for factoring; PURCHASE_ORDER for PO; etc.)
UPDATE lender_products
   SET category = CASE UPPER(TRIM(category))
       WHEN 'LOC'                       THEN 'LOC'
       WHEN 'LINE_OF_CREDIT'            THEN 'LOC'
       WHEN 'LINE OF CREDIT'            THEN 'LOC'
       WHEN 'RLOC'                      THEN 'LOC'
       WHEN 'REVOLVER'                  THEN 'LOC'

       WHEN 'TERM'                      THEN 'TERM'
       WHEN 'TERM_LOAN'                 THEN 'TERM'
       WHEN 'TERM LOAN'                 THEN 'TERM'
       WHEN 'TERMLOAN'                  THEN 'TERM'

       WHEN 'EQUIPMENT'                 THEN 'EQUIPMENT'
       WHEN 'EQUIPMENT_FINANCE'         THEN 'EQUIPMENT'
       WHEN 'EQUIPMENT_FINANCING'       THEN 'EQUIPMENT'
       WHEN 'EQUIPMENT FINANCING'       THEN 'EQUIPMENT'
       WHEN 'EQUIPMENT_LOAN'            THEN 'EQUIPMENT'

       WHEN 'FACTORING'                 THEN 'FACTORING'
       WHEN 'INVOICE_FACTORING'         THEN 'FACTORING'
       WHEN 'INVOICE FACTORING'         THEN 'FACTORING'
       WHEN 'AR_FACTORING'              THEN 'FACTORING'

       WHEN 'PO'                        THEN 'PO'
       WHEN 'PO_FINANCING'              THEN 'PO'
       WHEN 'PURCHASE_ORDER'            THEN 'PO'
       WHEN 'PURCHASE_ORDER_FINANCE'    THEN 'PO'
       WHEN 'PURCHASE_ORDER_FINANCING'  THEN 'PO'
       WHEN 'PURCHASE ORDER FINANCING'  THEN 'PO'

       WHEN 'MCA'                       THEN 'MCA'
       WHEN 'MERCHANT_CASH_ADVANCE'     THEN 'MCA'
       WHEN 'MERCHANT CASH ADVANCE'     THEN 'MCA'
       WHEN 'CASH_ADVANCE'              THEN 'MCA'

       WHEN 'MEDIA'                     THEN 'MEDIA'
       WHEN 'MEDIA_FUNDING'             THEN 'MEDIA'
       WHEN 'MEDIA FUNDING'             THEN 'MEDIA'

       WHEN 'ABL'                       THEN 'ABL'
       WHEN 'ASSET_BASED_LENDING'       THEN 'ABL'
       WHEN 'ASSET BASED LENDING'       THEN 'ABL'
       WHEN 'ASSET-BASED_LENDING'       THEN 'ABL'

       WHEN 'SBA'                       THEN 'SBA'
       WHEN 'SBA_GOVERNMENT'            THEN 'SBA'
       WHEN 'SBA_LOAN'                  THEN 'SBA'
       WHEN 'GOVERNMENT'                THEN 'SBA'

       WHEN 'STARTUP'                   THEN 'STARTUP'
       WHEN 'STARTUP_CAPITAL'           THEN 'STARTUP'
       WHEN 'STARTUP CAPITAL'           THEN 'STARTUP'
       WHEN 'STARTUP_FINANCING'         THEN 'STARTUP'
       ELSE NULL  -- unrecognized — quarantine below
     END;

-- 3f. Quarantine: any row whose normalized category is NULL gets
-- deactivated and logged. Its category_legacy still holds the original.
DO $$
DECLARE
  q int;
BEGIN
  SELECT count(*) INTO q FROM lender_products WHERE category IS NULL;
  IF q > 0 THEN
    RAISE WARNING 'v81b quarantining % lender_products rows with unrecognized category (category_legacy preserved, active=false)', q;
    UPDATE lender_products
       SET active = false
     WHERE category IS NULL
       AND active IS DISTINCT FROM false;
  END IF;
END$$;

-- 3g. NOTICE the AFTER-state for audit.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT COALESCE(category, '<null/quarantined>') AS cat, count(*) AS n
      FROM lender_products
     GROUP BY 1
     ORDER BY 2 DESC
  LOOP
    RAISE NOTICE 'v81b after-state: category=% count=%', r.cat, r.n;
  END LOOP;
END$$;

-- 3h. Now the constraint can be added without violation. The CHECK
-- allows NULL because quarantined rows have NULL category. (NULLs
-- are always allowed by CHECK constraints unless explicitly NOT NULL.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lender_products_category_check'
       AND conrelid = 'lender_products'::regclass
  ) THEN
    ALTER TABLE lender_products
      ADD CONSTRAINT lender_products_category_check
      CHECK (
        category IS NULL
        OR category IN ('LOC','TERM','FACTORING','PO','EQUIPMENT','MCA','MEDIA','ABL','SBA','STARTUP')
      );
  END IF;
END$$;

-- 3i. Trace marker.
DO $$ BEGIN RAISE NOTICE 'BF_SERVER_BLOCK_v81_CATEGORIES_COMPANION (hotfix v81b) applied'; END $$;
