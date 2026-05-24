-- BF_SERVER_BLOCK_v647_LENDER_PRODUCTS_SEED_v1
-- Idempotent: schema + UPSERT seed for all lenders + products from
-- Todd's boreal_lenders_products.xlsx (42 products, 12 lenders).
--
-- Schema additions (additive, IF NOT EXISTS — existing TEXT min_rate/max_rate
-- preserved for older readers; new numeric columns + rate_kind are what the
-- portal Lender Product editor + the wizard's product-matching code will use
-- going forward).

-- 1. Add new columns ─────────────────────────────────────────────────────
ALTER TABLE lender_products
  ADD COLUMN IF NOT EXISTS rate_kind        TEXT,
  ADD COLUMN IF NOT EXISTS rate_min_num     NUMERIC(7, 3),
  ADD COLUMN IF NOT EXISTS rate_max_num     NUMERIC(7, 3),
  ADD COLUMN IF NOT EXISTS category_label   TEXT,
  ADD COLUMN IF NOT EXISTS documents_required TEXT;

-- 2. Constrain rate_kind to the 3 values from the spreadsheet ───────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'lender_products'
      AND c.conname = 'lender_products_rate_kind_check'
  ) THEN
    ALTER TABLE lender_products
      ADD CONSTRAINT lender_products_rate_kind_check
      CHECK (rate_kind IS NULL OR rate_kind IN ('APR %', 'Monthly %', 'Factor (MCA)'));
  END IF;
END $$;

-- 3. UNIQUE constraint on (lender_id, name) so the UPSERTs below land safely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'lender_products'
      AND c.conname = 'lender_products_lender_id_name_key'
  ) THEN
    -- Pre-clean any duplicate (lender_id, name) rows: keep the most recent.
    DELETE FROM lender_products lp1
      USING lender_products lp2
     WHERE lp1.lender_id = lp2.lender_id
       AND lp1.name = lp2.name
       AND lp1.created_at < lp2.created_at;
    ALTER TABLE lender_products
      ADD CONSTRAINT lender_products_lender_id_name_key UNIQUE (lender_id, name);
  END IF;
END $$;

-- 4. UNIQUE constraint on lenders.name so the lender UPSERTs land safely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'lenders' AND c.conname = 'lenders_name_key'
  ) THEN
    -- De-dup lenders by name first (keep most recent).
    DELETE FROM lenders l1
      USING lenders l2
     WHERE l1.name = l2.name
       AND l1.created_at < l2.created_at;
    ALTER TABLE lenders ADD CONSTRAINT lenders_name_key UNIQUE (name);
  END IF;
END $$;

-- 5. Backfill rate_kind on legacy rows that have min_rate/max_rate as TEXT
-- but no rate_kind set. Default to 'APR %' (the most common kind) so the
-- portal editor doesn't show a blank dropdown for old rows.
UPDATE lender_products
   SET rate_kind = 'APR %'
 WHERE rate_kind IS NULL
   AND (min_rate IS NOT NULL OR max_rate IS NOT NULL);

-- 6. Numeric mirror of legacy TEXT rates (best-effort, swallow non-numerics).
UPDATE lender_products
   SET rate_min_num = NULLIF(regexp_replace(min_rate, '[^0-9.]', '', 'g'), '')::NUMERIC,
       rate_max_num = NULLIF(regexp_replace(max_rate, '[^0-9.]', '', 'g'), '')::NUMERIC
 WHERE rate_min_num IS NULL
   AND (min_rate IS NOT NULL OR max_rate IS NOT NULL);

-- 12 lenders, 42 products

-- Lender UPSERTs
-- BF_SERVER_BLOCK_v647_LENDER_PRODUCTS_SEED_v1 — hotfix for production
-- crash on 2026-05-24: lenders.submission_method has a column default of
-- 'email' (lowercase, from migration 050) but a CHECK constraint requires
-- uppercase ('EMAIL', from migration 041). Setting it explicitly on every
-- row so the row passes the constraint and the migration completes.
INSERT INTO lenders (id, name, country, active, submission_method, created_at, updated_at) VALUES
  (gen_random_uuid(), 'Accord', 'BOTH', TRUE, 'EMAIL', NOW(), NOW()),
  (gen_random_uuid(), 'Accord Financial Corp.', 'BOTH', TRUE, 'EMAIL', NOW(), NOW()),
  (gen_random_uuid(), 'Baker Garrington Capital', 'BOTH', TRUE, 'EMAIL', NOW(), NOW()),
  (gen_random_uuid(), 'Brookridge Funding LLV', 'BOTH', TRUE, 'EMAIL', NOW(), NOW()),
  (gen_random_uuid(), 'Dynamic Capital Equipment Finance', 'BOTH', TRUE, 'EMAIL', NOW(), NOW()),
  (gen_random_uuid(), 'Meridian OneCap Credit Corp.', 'BOTH', TRUE, 'EMAIL', NOW(), NOW()),
  (gen_random_uuid(), 'Mobilization Funding', 'BOTH', TRUE, 'EMAIL', NOW(), NOW()),
  (gen_random_uuid(), 'Pathward', 'BOTH', TRUE, 'EMAIL', NOW(), NOW()),
  (gen_random_uuid(), 'Pearl Capital Final', 'BOTH', TRUE, 'EMAIL', NOW(), NOW()),
  (gen_random_uuid(), 'Quantum LS', 'BOTH', TRUE, 'EMAIL', NOW(), NOW()),
  (gen_random_uuid(), 'Revenued', 'BOTH', TRUE, 'EMAIL', NOW(), NOW()),
  (gen_random_uuid(), 'Stride Capital Corp.', 'BOTH', TRUE, 'EMAIL', NOW(), NOW())
ON CONFLICT (name) DO UPDATE SET active = TRUE, updated_at = NOW();
-- Note: existing lenders' submission_method values are NOT touched by the
-- ON CONFLICT clause — we only set it when inserting a new row, so this
-- doesn't overwrite Andrew/Todd's manual config on any pre-existing lender.

-- Product UPSERTs
INSERT INTO lender_products
  (id, lender_id, lender_name, name, category, category_label, country,
   min_amount, max_amount, rate_kind, rate_min_num, rate_max_num,
   term_min, term_max, term_unit, active, status, documents_required, created_at, updated_at)
VALUES
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Accord' LIMIT 1), 'Accord', 'AccordAccess', 'LOC'::lender_product_category, 'Working Capital', 'CA', 5000, 50000, 'APR %', 19.99, 49.99, 6, 24, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Accord' LIMIT 1), 'Accord', 'Small Business Revolver - No Borrowing Base', 'LOC'::lender_product_category, 'Business Line of Credit', 'CA', 25000, 250000, 'APR %', 10.0, 35.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Personal Financial Statement; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Accord Financial Corp.' LIMIT 1), 'Accord Financial Corp.', 'Equipment Finance', 'EQUIPMENT'::lender_product_category, 'Equipment Financing', 'CA', 20000, 1500000, 'APR %', 9.0, 20.0, 12, 72, 'MONTHS', TRUE, 'ACTIVE', 'Balance Sheet; Accountant Prepared Financials; Profit and Loss Statement; Bank Statements; Purchase order/Invoice of equipment to be financed', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Baker Garrington Capital' LIMIT 1), 'Baker Garrington Capital', 'Accounts Receivable Factoring', 'FACTORING'::lender_product_category, 'Invoice Factoring', 'CA', 10000, 30000000, 'Monthly %', 1.0, 3.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Accountant Prepared Financials; Articles of Incorporation; Profit and Loss Statement; Balance Sheet', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Baker Garrington Capital' LIMIT 1), 'Baker Garrington Capital', 'Accounts Receivable Factoring', 'FACTORING'::lender_product_category, 'Invoice Factoring', 'US', 10000, 30000000, 'Monthly %', 1.0, 3.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Accountant Prepared Financials; Articles of Incorporation; Profit and Loss Statement; Balance Sheet', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Baker Garrington Capital' LIMIT 1), 'Baker Garrington Capital', 'Asset-Based Lending', 'FACTORING'::lender_product_category, 'Invoice Factoring', 'CA', 3000000, 20000000, 'APR %', 12.0, 16.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Income Statement; Balance Sheet; Profit and Loss Statement; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Baker Garrington Capital' LIMIT 1), 'Baker Garrington Capital', 'Asset-Based Lending', 'LOC'::lender_product_category, 'Business Line of Credit', 'US', 3000000, 20000000, 'APR %', 12.0, 16.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Balance Sheet; Income Statement; Accountant Prepared Financials; Profit and Loss Statement', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Baker Garrington Capital' LIMIT 1), 'Baker Garrington Capital', 'Equipment Financing', 'EQUIPMENT'::lender_product_category, 'Equipment Financing', 'CA', 1000000, 20000000, 'APR %', 12.0, 16.0, 72, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Accountant Prepared Financials; Balance Sheet; Personal Financial Statement; Profit and Loss Statement; Purchase order/Invoice of equipment to be financed', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Baker Garrington Capital' LIMIT 1), 'Baker Garrington Capital', 'Equipment Financing', 'EQUIPMENT'::lender_product_category, 'Equipment Financing', 'US', 1000000, 20000000, 'APR %', 12.0, 16.0, 72, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Accountant Prepared Financials; Balance Sheet; Profit and Loss Statement; Purchase order/Invoice of equipment to be financed', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Baker Garrington Capital' LIMIT 1), 'Baker Garrington Capital', 'Factor+ - (Short-term notes with BG Factoring)', 'FACTORING'::lender_product_category, 'Invoice Factoring', 'CA', 1, 1000000, 'APR %', 10.0, 18.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Accountant Prepared Financials; Balance Sheet; Profit and Loss Statement', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Baker Garrington Capital' LIMIT 1), 'Baker Garrington Capital', 'Factor+ - (Short-term notes with BG Factoring)', 'FACTORING'::lender_product_category, 'Invoice Factoring', 'US', 1, 1000000, 'APR %', 10.0, 18.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Accountant Prepared Financials; Balance Sheet; Profit and Loss Statement', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Brookridge Funding LLV' LIMIT 1), 'Brookridge Funding LLV', 'Purchase Order Financing', 'PO'::lender_product_category, 'Purchase Order Financing', 'US', 50000, 30000000, 'Monthly %', 2.5, 3.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Accountant Prepared Financials; Articles of Incorporation; Balance Sheet; Profit and Loss Statement', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Dynamic Capital Equipment Finance' LIMIT 1), 'Dynamic Capital Equipment Finance', 'Equipment Finance', 'EQUIPMENT'::lender_product_category, 'Equipment Financing', 'CA', 35000, 2000000, 'APR %', 6.5, 20.0, 12, 72, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials; Purchase order/Invoice of equipment to be financed', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Meridian OneCap Credit Corp.' LIMIT 1), 'Meridian OneCap Credit Corp.', 'Equipment Finance', 'EQUIPMENT'::lender_product_category, 'Equipment Financing', 'CA', 25000, 2000000, 'APR %', 6.5, 12.0, 12, 81, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Personal Financial Statement; Balance Sheet; Accountant Prepared Financials; Purchase order/Invoice of equipment to be financed', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Mobilization Funding' LIMIT 1), 'Mobilization Funding', 'Contract Financing', 'FACTORING'::lender_product_category, 'Invoice Factoring', 'US', 100000, 5000000, 'Monthly %', 1.9, 3.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Mobilization Funding' LIMIT 1), 'Mobilization Funding', 'Mobilization Funding', 'LOC'::lender_product_category, 'Business Line of Credit', 'US', 100000, 5000000, 'Monthly %', 1.0, 1.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Mobilization Funding' LIMIT 1), 'Mobilization Funding', 'PO Financing', 'PO'::lender_product_category, 'Purchase Order Financing', 'US', 100000, 5000000, 'Monthly %', 1.0, 1.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Pathward' LIMIT 1), 'Pathward', 'ABL Working Capital', 'LOC'::lender_product_category, 'Business Line of Credit', 'US', 1000000, 20000000, 'Monthly %', 2.0, 4.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Accountant Prepared Financials; Balance Sheet; Profit and Loss Statement', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Pathward' LIMIT 1), 'Pathward', 'ABL Working Capital Revolver', 'LOC'::lender_product_category, 'Business Line of Credit', 'CA', 1000000, 20000000, 'Monthly %', 2.0, 4.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Accountant Prepared Financials; Profit and Loss Statement; Balance Sheet', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Pearl Capital Final' LIMIT 1), 'Pearl Capital Final', 'MCA', 'TERM'::lender_product_category, 'Term Loan', 'US', 35000, 149999, 'Factor (MCA)', 1.24, 1.45, 3, 9, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Pearl Capital Final' LIMIT 1), 'Pearl Capital Final', 'MCA', 'TERM'::lender_product_category, 'Term Loan', 'US', 10000, 34999, 'Factor (MCA)', 1.24, 1.45, 3, 9, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Pearl Capital Final' LIMIT 1), 'Pearl Capital Final', 'MCA', 'TERM'::lender_product_category, 'Term Loan', 'US', 250000, 1000000, 'Factor (MCA)', 1.24, 1.45, 3, 9, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Pearl Capital Final' LIMIT 1), 'Pearl Capital Final', 'MCA', 'TERM'::lender_product_category, 'Term Loan', 'US', 150000, 249999, 'Factor (MCA)', 1.24, 1.45, 3, 9, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Quantum LS' LIMIT 1), 'Quantum LS', 'Flex Line', 'LOC'::lender_product_category, 'Working Capital', 'CA', 150001, 199999, 'APR %', 16.99, 35.99, 12, 48, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Balance Sheet; Accountant Prepared Financials; Profit and Loss Statement', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Quantum LS' LIMIT 1), 'Quantum LS', 'Line of credit', 'LOC'::lender_product_category, 'Business Line of Credit', 'US', 10000, 150000, 'Monthly %', 1.9, 3.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Quantum LS' LIMIT 1), 'Quantum LS', 'Term Loan', 'TERM'::lender_product_category, 'Term Loan', 'US', 200000, 250000, 'APR %', 16.99, 35.99, 12, 48, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Balance Sheet; Profit and Loss Statement; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Quantum LS' LIMIT 1), 'Quantum LS', 'Term Loan', 'TERM'::lender_product_category, 'Term Loan', 'US', 10000, 150000, 'APR %', 16.99, 35.99, 12, 48, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Quantum LS' LIMIT 1), 'Quantum LS', 'Term Loan', 'TERM'::lender_product_category, 'Term Loan', 'US', 150001, 199999, 'APR %', 16.99, 35.99, 12, 48, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Quantum LS' LIMIT 1), 'Quantum LS', 'Term Loan', 'TERM'::lender_product_category, 'Term Loan', 'US', 10000, 150000, 'APR %', 16.99, 35.99, 12, 48, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flex Line', 'LOC'::lender_product_category, 'Business Line of Credit', 'CA', 20000, 149999, 'Monthly %', 1.0, 1.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flex Line', 'LOC'::lender_product_category, 'Business Line of Credit', 'CA', 250000, 500000, 'Monthly %', 1.0, 1.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Accountant Prepared Financials; Profit and Loss Statement; Balance Sheet', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flex Line', 'LOC'::lender_product_category, 'Business Line of Credit', 'CA', 3000, 19999, 'Factor (MCA)', 1.25, 1.45, 10, 10, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flex Line', 'LOC'::lender_product_category, 'Business Line of Credit', 'CA', 150000, 249999, 'Monthly %', 1.0, 1.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Accountant Prepared Financials; Profit and Loss Statement; Balance Sheet', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flex Line', 'LOC'::lender_product_category, 'Business Line of Credit', 'CA', 3000, 19999, 'Monthly %', 1.0, 1.0, 12, 12, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flex Line', 'LOC'::lender_product_category, 'Business Line of Credit', 'US', 250000, 500000, 'Factor (MCA)', 1.25, 1.45, 10, 10, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Balance Sheet; Profit and Loss Statement; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flex Line', 'LOC'::lender_product_category, 'Business Line of Credit', 'US', 150000, 249999, 'Factor (MCA)', 1.25, 1.45, 10, 10, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Balance Sheet; Accountant Prepared Financials; Profit and Loss Statement', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flex Line', 'LOC'::lender_product_category, 'Business Line of Credit', 'US', 20000, 149999, 'Factor (MCA)', 1.25, 1.45, 10, 10, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flexline', 'TERM'::lender_product_category, 'Term Loan', 'US', 250000, 500000, 'Factor (MCA)', 1.25, 1.45, 3, 9, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flexline', 'TERM'::lender_product_category, 'Term Loan', 'US', 20000, 149999, 'Factor (MCA)', 1.25, 1.45, 3, 9, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flexline', 'TERM'::lender_product_category, 'Term Loan', 'US', 150000, 249000, 'Factor (MCA)', 1.25, 1.45, 3, 9, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements; Profit and Loss Statement; Balance Sheet; Accountant Prepared Financials', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Revenued' LIMIT 1), 'Revenued', 'Flexline', 'LOC'::lender_product_category, 'Business Line of Credit', 'US', 5000, 19999, 'Factor (MCA)', 1.25, 1.45, 3, 9, 'MONTHS', TRUE, 'ACTIVE', 'Bank Statements', NOW(), NOW()),
  (gen_random_uuid(), (SELECT id FROM lenders WHERE name = 'Stride Capital Corp.' LIMIT 1), 'Stride Capital Corp.', 'Equipment Finance', 'EQUIPMENT'::lender_product_category, 'Equipment Financing', 'CA', 25000, 1500000, 'APR %', 6.5, 15.0, 12, 72, 'MONTHS', TRUE, 'ACTIVE', 'Balance Sheet; Accountant Prepared Financials; Profit and Loss Statement; Bank Statements; Purchase order/Invoice of equipment to be financed', NOW(), NOW())
ON CONFLICT (lender_id, name) DO UPDATE SET
  category = EXCLUDED.category,
  category_label = EXCLUDED.category_label,
  country = EXCLUDED.country,
  min_amount = EXCLUDED.min_amount,
  max_amount = EXCLUDED.max_amount,
  rate_kind = EXCLUDED.rate_kind,
  rate_min_num = EXCLUDED.rate_min_num,
  rate_max_num = EXCLUDED.rate_max_num,
  term_min = EXCLUDED.term_min,
  term_max = EXCLUDED.term_max,
  documents_required = EXCLUDED.documents_required,
  active = TRUE,
  status = 'ACTIVE',
  updated_at = NOW();
