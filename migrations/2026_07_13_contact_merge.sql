-- BF_SERVER_CONTACT_MERGE_v1
-- The existing /contacts/dedupe-merge is not a merge: it ARCHIVES duplicates that have no
-- activity, found only by exact email or exact phone. Every real duplicate in this database
-- has activity on both records AND differs on both email and phone:
--   * Mike Cotic       - contact form vs Microsoft Bookings ("Mike Cotic" / "MICHAEL COTIC")
--   * Juergen Zischler - three records, three emails, three phones
--   * Wayne Beamish    - email contact (no phone) vs booking contact (phone)
-- So the old preview cannot see a single one of them.
--
-- NOTE: the first version of this migration used PostgreSQL trigram matching. Azure Database for PostgreSQL
-- does NOT allow-list that extension, so creating it threw, and because the migration
-- runner is fatal by design the whole app crash-looped on boot. Name matching below is
-- therefore PURE SQL with no extension dependency.
--
-- Each helper inlines its own normalisation instead of calling the others: Postgres inlines
-- SQL functions into index expressions, and a nested call fails to resolve there
-- ("function bf_norm_name(text) does not exist").
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
  moved jsonb NOT NULL DEFAULT '{}'::jsonb,
  loser_snapshot jsonb,
  merged_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_merges_survivor_idx ON contact_merges (survivor_id);
CREATE INDEX IF NOT EXISTS contact_merges_loser_idx ON contact_merges (loser_id);

CREATE OR REPLACE FUNCTION bf_norm_name(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS
$FN$ SELECT btrim(regexp_replace(regexp_replace(lower(coalesce(p,'')), '[^a-z ]', ' ', 'g'), ' +', ' ', 'g')); $FN$;

CREATE OR REPLACE FUNCTION bf_surname(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS
$FN$ SELECT (string_to_array(btrim(regexp_replace(regexp_replace(lower(coalesce(p,'')), '[^a-z ]', ' ', 'g'), ' +', ' ', 'g')), ' '))[
       array_length(string_to_array(btrim(regexp_replace(regexp_replace(lower(coalesce(p,'')), '[^a-z ]', ' ', 'g'), ' +', ' ', 'g')), ' '), 1)]; $FN$;

CREATE OR REPLACE FUNCTION bf_forename(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS
$FN$ SELECT (string_to_array(btrim(regexp_replace(regexp_replace(lower(coalesce(p,'')), '[^a-z ]', ' ', 'g'), ' +', ' ', 'g')), ' '))[1]; $FN$;

-- Same person by name. The SURNAME must match exactly; the forename then matches if it is
-- identical, a prefix of the other (Mike/Michael, Dave/David), or shares a first initial.
-- "Mike Cotic" finds "MICHAEL COTIC"; it does not find "Mike Jones" or "Sarah Cotic".
-- plpgsql, so it is never inlined into an index and can safely call the helpers above.
CREATE OR REPLACE FUNCTION bf_same_person_name(a text, b text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_catalog AS
$FN$
DECLARE na text; nb text; sa text; sb text; fa text; fb text;
BEGIN
  na := bf_norm_name(a); nb := bf_norm_name(b);
  IF na = '' OR nb = '' THEN RETURN false; END IF;
  IF na = nb THEN RETURN true; END IF;
  sa := bf_surname(a); sb := bf_surname(b);
  IF sa IS DISTINCT FROM sb OR length(coalesce(sa,'')) < 2 THEN RETURN false; END IF;
  fa := bf_forename(a); fb := bf_forename(b);
  RETURN fa = fb
      OR (length(fa) >= 3 AND fb LIKE fa || '%')
      OR (length(fb) >= 3 AND fa LIKE fb || '%')
      OR left(fa, 1) = left(fb, 1);
END;
$FN$;

CREATE INDEX IF NOT EXISTS contacts_surname_idx ON contacts (bf_surname(name))
  WHERE name IS NOT NULL;
