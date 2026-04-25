-- 130_users_silos_array.sql
-- Add a silos[] allowlist to users so multi-silo staff can switch via
-- the topbar selector. Single-silo users still use the existing silo
-- column. Fully idempotent.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS silos TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill: every existing user gets their current silo as the only
-- entry in the allowlist if the array is empty.
UPDATE users
   SET silos = ARRAY[silo]
 WHERE (silos IS NULL OR array_length(silos, 1) IS NULL)
   AND silo IS NOT NULL
   AND silo <> '';

CREATE INDEX IF NOT EXISTS users_silos_gin_idx ON users USING gin (silos);
