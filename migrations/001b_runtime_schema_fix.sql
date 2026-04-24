-- Runtime repair applied after initial schema (001_init.sql).
-- Renamed from 001_runtime_schema_fix.sql to resolve duplicate 001 prefix.
-- Safe to run multiple times (all statements use IF EXISTS / IF NOT EXISTS).

ALTER TABLE IF EXISTS applications
ADD COLUMN IF NOT EXISTS owner_user_id UUID;

ALTER TABLE IF EXISTS applications
ADD COLUMN IF NOT EXISTS pipeline_state TEXT DEFAULT 'new';

ALTER TABLE IF EXISTS applications
ADD COLUMN IF NOT EXISTS name TEXT;

ALTER TABLE IF EXISTS applications
ADD COLUMN IF NOT EXISTS business_legal_name TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'applications'
  ) THEN
    UPDATE applications
    SET name = business_legal_name
    WHERE name IS NULL;
  END IF;
END $$;

ALTER TABLE IF EXISTS idempotency_keys
ADD COLUMN IF NOT EXISTS method TEXT;

ALTER TABLE IF EXISTS idempotency_keys
ALTER COLUMN method DROP NOT NULL;
