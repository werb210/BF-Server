-- BF_SERVER_BLOCK_v303_CONTACTS_PROFILE_COLUMNS_v1
-- Add the three contacts-table columns that createContact (src/services/contacts.ts:48)
-- INSERTs into but which were never added by any prior migration:
--   contacts.first_name TEXT
--   contacts.last_name  TEXT
--   contacts.user_id    UUID   (second user link alongside owner_id; the
--                               INSERT passes the same owner_id value into
--                               both slots — legacy carry-over kept intact)
--
-- These columns are also read by:
--   - src/routes/crm.ts (CRM contact listing — c.first_name)
--   - src/modules/applications/applications.routes.ts (drawer Applicants
--     tab — c.first_name, c.last_name)
--
-- Without these columns:
--   - POST /api/crm/contacts                        — INSERT 42703 "column does not exist"
--   - GET  /api/crm/contacts                        — SELECT 42703 same
--   - GET  /api/applications/:id/contacts           — SELECT 42703 same
--
-- Production may have these columns hand-added; this migration makes the
-- schema match the code so fresh deploys work identically. Pattern is v271
-- from the BI audit (migration that should have ALTER'd but didn't, leaving
-- the table missing columns that INSERTs assume are present).

ALTER TABLE IF EXISTS contacts ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE IF EXISTS contacts ADD COLUMN IF NOT EXISTS last_name  text;
ALTER TABLE IF EXISTS contacts ADD COLUMN IF NOT EXISTS user_id    uuid;

-- Best-effort FK to users for user_id. Idempotent: only adds if missing,
-- and swallows the add if any orphan rows would block it (the column stays
-- usable as a plain uuid even without the FK).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='contacts')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.table_constraints
       WHERE constraint_name = 'contacts_user_id_fkey'
         AND table_name = 'contacts'
     ) THEN
    BEGIN
      ALTER TABLE contacts
        ADD CONSTRAINT contacts_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
    EXCEPTION WHEN others THEN
      -- Don't fail the migration if the FK can't be added (e.g. orphans).
      NULL;
    END;
  END IF;
END $$;

-- Backfill first_name / last_name from the existing 'name' column where the
-- new columns are still empty. Splits on the first whitespace run; the rest
-- becomes last_name. Pre-existing first_name/last_name values are preserved.
UPDATE contacts
   SET first_name = trim(split_part(coalesce(name, ''), ' ', 1)),
       last_name  = trim(regexp_replace(coalesce(name, ''), '^\S+\s*', ''))
 WHERE (first_name IS NULL OR first_name = '')
   AND coalesce(name, '') <> '';

CREATE INDEX IF NOT EXISTS contacts_user_id_idx ON contacts(user_id);
