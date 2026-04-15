-- Adds missing country column to lenders table.
-- Runs after 030 which creates the lenders table.
-- Renamed from 031_lender_schema_alignment.sql to avoid confusion with 030.

-- lenders table
ALTER TABLE lenders
ADD COLUMN IF NOT EXISTS country TEXT;

-- lender_products table
ALTER TABLE lender_products
ADD COLUMN IF NOT EXISTS required_documents JSONB NOT NULL DEFAULT '[]';
