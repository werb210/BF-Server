-- BF_SERVER_CONTACT_MERGE_v1
-- The existing /contacts/dedupe-merge is not a merge: it ARCHIVES duplicates that have no
-- activity at all (no applications, messages, notes, tasks or call events). Every real
-- duplicate in this database has activity on both records, so it does nothing for them:
--   * Mike Cotic - contact form (phgymmississauga@gmail.com / +19059563852) vs Bookings
--     (ffxinc@gmail.com / +19055698018). Same person, POWERHOUSE GYM, live working-capital
--     lead, fragmented across two records with activity on each.
--   * Juergen Zischler - three records, three emails, three phones.
--   * Wayne Beamish - email contact (no phone) vs booking contact (phone).
-- None of them share an email or a phone, so the existing preview cannot even SEE them.
--
-- This adds the audit trail for a real merge: the survivor keeps everything, the losers are
-- archived with a pointer, and the whole thing is recoverable because we snapshot what moved.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS merged_into_id uuid,
  ADD COLUMN IF NOT EXISTS merged_at timestamptz;

CREATE INDEX IF NOT EXISTS contacts_merged_into_idx ON contacts (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  survivor_id uuid NOT NULL,
  loser_id uuid NOT NULL,
  moved jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { table: rows_repointed }
  loser_snapshot jsonb,                       -- the full losing row, so a bad merge is recoverable
  merged_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_merges_survivor_idx ON contact_merges (survivor_id);
CREATE INDEX IF NOT EXISTS contact_merges_loser_idx ON contact_merges (loser_id);

-- pg_trgm powers the fuzzy name match that finds the duplicates the old preview cannot see.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS contacts_name_trgm_idx ON contacts USING gin (lower(name) gin_trgm_ops);
