-- BF_SERVER_BLOCK_v100_APPLICATIONS_SILO_DEFAULT_v1
-- Backfill, default, NOT NULL — fully idempotent.

-- 1) Backfill rows that came in via /api/public/application/start
--    before the code-side fix landed.
UPDATE applications SET silo = 'BF' WHERE silo IS NULL;

-- 2) Establish DEFAULT 'BF' so future inserts that omit the column
--    pick up the silo value automatically.
ALTER TABLE applications ALTER COLUMN silo SET DEFAULT 'BF';

-- 3) Lock NOT NULL once the backfill has run. Wrapped in a
--    DO block so a second run doesn't error on already-NOT NULL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'applications'
       AND column_name = 'silo'
       AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE applications ALTER COLUMN silo SET NOT NULL;
  END IF;
END $$;

-- 4) Sanity index — already exists from migration 132, but
--    keeping the IF NOT EXISTS makes this file standalone.
CREATE INDEX IF NOT EXISTS applications_silo_idx ON applications (silo);
