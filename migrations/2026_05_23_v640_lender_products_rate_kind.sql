-- BF_SERVER_BLOCK_v640_RATE_KIND_v1 — adds rate_kind to lender_products.
-- Three distinct rate semantics that today are all crammed into interest_min/max:
--   apr     → annual percentage rate (term loans, equipment finance, working capital)
--   monthly → percent per MONTH (factoring, AR, PO, ABL revolvers)
--   factor  → MCA payback multiplier (1.24x means borrower repays $1.24 per $1)
-- The existing rate_type column (FIXED|VARIABLE) is orthogonal and unchanged.

ALTER TABLE IF EXISTS lender_products
  ADD COLUMN IF NOT EXISTS rate_kind TEXT,
  ADD COLUMN IF NOT EXISTS rate_period_days INTEGER;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'lender_products'
      AND constraint_name = 'lender_products_rate_kind_check'
  ) THEN
    ALTER TABLE lender_products DROP CONSTRAINT lender_products_rate_kind_check;
  END IF;
  ALTER TABLE lender_products
    ADD CONSTRAINT lender_products_rate_kind_check
    CHECK (rate_kind IS NULL OR rate_kind IN ('apr', 'monthly', 'factor'));
END $$;

UPDATE lender_products
SET rate_kind = CASE
  WHEN (
    LOWER(COALESCE(category::text, '')) IN ('mca', 'merchant cash advance')
    OR name ILIKE '%MCA%'
    OR name ILIKE '%Flex Line%'
    OR name ILIKE '%Flexline%'
  )
  AND interest_min ~ '^[0-9]+(\\.[0-9]+)?$'
  AND interest_max ~ '^[0-9]+(\\.[0-9]+)?$'
  AND CAST(interest_min AS NUMERIC) BETWEEN 1.0 AND 2.0
  AND CAST(interest_max AS NUMERIC) BETWEEN 1.0 AND 2.0
  THEN 'factor'

  WHEN (
    LOWER(COALESCE(category::text, '')) IN (
      'factoring', 'invoice factoring',
      'po', 'po_funding', 'purchase order financing',
      'loc', 'business line of credit',
      'abl', 'asset-based lending'
    )
    OR name ILIKE '%ABL%'
    OR name ILIKE '%Asset-Based%'
    OR name ILIKE '%Asset Based%'
  )
  AND interest_min ~ '^[0-9]+(\\.[0-9]+)?$'
  AND interest_max ~ '^[0-9]+(\\.[0-9]+)?$'
  AND CAST(interest_min AS NUMERIC) <= 5
  AND CAST(interest_max AS NUMERIC) <= 5
  THEN 'monthly'

  ELSE 'apr'
END
WHERE rate_kind IS NULL;

CREATE INDEX IF NOT EXISTS lender_products_rate_kind_idx ON lender_products(rate_kind);
