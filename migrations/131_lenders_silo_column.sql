-- 131_lenders_silo_column.sql
-- Add silo column to lenders and lender_products tables for
-- per-silo segregation. Fully idempotent.

ALTER TABLE lenders
  ADD COLUMN IF NOT EXISTS silo TEXT NULL;

ALTER TABLE lender_products
  ADD COLUMN IF NOT EXISTS silo TEXT NULL;

-- Existing rows have NULL silo, which the application treats as
-- "visible to all silos" until an admin assigns specific silos.
CREATE INDEX IF NOT EXISTS lenders_silo_idx ON lenders (silo);
CREATE INDEX IF NOT EXISTS lender_products_silo_idx ON lender_products (silo);
