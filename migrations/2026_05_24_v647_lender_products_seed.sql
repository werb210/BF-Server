-- BF_SERVER_BLOCK_v647_LENDER_PRODUCTS_SEED_v1
-- Idempotent: schema + UPSERT seed for all lenders + products from
-- Todd's boreal_lenders_products.xlsx (42 products, 12 lenders).

-- 1. Add new columns ─────────────────────────────────────────────────────
ALTER TABLE lender_products
  ADD COLUMN IF NOT EXISTS rate_kind        TEXT,
  ADD COLUMN IF NOT EXISTS rate_min_num     NUMERIC(7, 3),
  ADD COLUMN IF NOT EXISTS rate_max_num     NUMERIC(7, 3),
  ADD COLUMN IF NOT EXISTS category_label   TEXT,
  ADD COLUMN IF NOT EXISTS documents_required TEXT;

-- 2. Constrain rate_kind to the 3 values from the spreadsheet
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

-- 3. UNIQUE constraint on (lender_id, name) so UPSERTs land safely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'lender_products'
      AND c.conname = 'lender_products_lender_id_name_key'
  ) THEN
    DELETE FROM lender_products lp1
      USING lender_products lp2
     WHERE lp1.lender_id = lp2.lender_id
       AND lp1.name = lp2.name
       AND lp1.created_at < lp2.created_at;
    ALTER TABLE lender_products
      ADD CONSTRAINT lender_products_lender_id_name_key UNIQUE (lender_id, name);
  END IF;
END $$;

-- 4. UNIQUE constraint on lenders.name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'lenders' AND c.conname = 'lenders_name_key'
  ) THEN
    DELETE FROM lenders l1
      USING lenders l2
     WHERE l1.name = l2.name
       AND l1.created_at < l2.created_at;
    ALTER TABLE lenders ADD CONSTRAINT lenders_name_key UNIQUE (name);
  END IF;
END $$;

-- 5. Backfill rate_kind on legacy rows.
UPDATE lender_products
   SET rate_kind = 'APR %'
 WHERE rate_kind IS NULL
   AND (min_rate IS NOT NULL OR max_rate IS NOT NULL);

-- 6. Numeric mirror of legacy TEXT rates.
UPDATE lender_products
   SET rate_min_num = NULLIF(regexp_replace(min_rate, '[^0-9.]', '', 'g'), '')::NUMERIC,
       rate_max_num = NULLIF(regexp_replace(max_rate, '[^0-9.]', '', 'g'), '')::NUMERIC
 WHERE rate_min_num IS NULL
   AND (min_rate IS NOT NULL OR max_rate IS NOT NULL);

-- 7. Lender UPSERTs (12 lenders).
INSERT INTO lenders (id, name, country, active, created_at, updated_at) VALUES
  (gen_random_uuid(), 'Accord', 'BOTH', TRUE, NOW(), NOW()),
  (gen_random_uuid(), 'Accord Financial Corp.', 'BOTH', TRUE, NOW(), NOW()),
  (gen_random_uuid(), 'Baker Garrington Capital', 'BOTH', TRUE, NOW(), NOW()),
  (gen_random_uuid(), 'Brookridge Funding LLV', 'BOTH', TRUE, NOW(), NOW()),
  (gen_random_uuid(), 'Dynamic Capital Equipment Finance', 'BOTH', TRUE, NOW(), NOW()),
  (gen_random_uuid(), 'Meridian OneCap Credit Corp.', 'BOTH', TRUE, NOW(), NOW()),
  (gen_random_uuid(), 'Mobilization Funding', 'BOTH', TRUE, NOW(), NOW()),
  (gen_random_uuid(), 'Pathward', 'BOTH', TRUE, NOW(), NOW()),
  (gen_random_uuid(), 'Pearl Capital Final', 'BOTH', TRUE, NOW(), NOW()),
  (gen_random_uuid(), 'Quantum LS', 'BOTH', TRUE, NOW(), NOW()),
  (gen_random_uuid(), 'Revenued', 'BOTH', TRUE, NOW(), NOW()),
  (gen_random_uuid(), 'Stride Capital Corp.', 'BOTH', TRUE, NOW(), NOW())
ON CONFLICT (name) DO UPDATE SET active = TRUE, updated_at = NOW();
