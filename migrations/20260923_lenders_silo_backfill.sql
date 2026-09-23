-- BF_SERVER_LENDER_SILO_v449
-- Migration 131 added lenders.silo and lender_products.silo as TEXT NULL and
-- never populated them. Every silo-filtered query has therefore returned zero
-- rows since, which is why staff Maya answered "Boreal currently works with 0
-- lenders" while the visitor-facing count said 115.
-- Migration 132 did the equivalent backfill for applications; this is the one
-- that was missed. Idempotent: only touches rows still NULL.
ALTER TABLE lenders          ADD COLUMN IF NOT EXISTS silo TEXT NULL;
ALTER TABLE lender_products  ADD COLUMN IF NOT EXISTS silo TEXT NULL;

UPDATE lenders         SET silo = 'BF' WHERE silo IS NULL;
UPDATE lender_products SET silo = 'BF' WHERE silo IS NULL;

CREATE INDEX IF NOT EXISTS lenders_silo_idx         ON lenders (silo);
CREATE INDEX IF NOT EXISTS lender_products_silo_idx ON lender_products (silo);
