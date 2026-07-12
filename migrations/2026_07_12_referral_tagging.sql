-- BF_SERVER_REFERRAL_TAGGING_v1
-- Nothing in the referral system ever wrote a CRM tag. Referrers and referrals were
-- linked by columns (contacts.ref_code / contacts.referrer_id) but the CRM surfaces
-- relationships through TAGS, so both sides were invisible in the UI - which is why
-- the one existing referrer showed up untagged.
--
-- Asserts every column it touches (see BF_SERVER_TEAMS_MEETINGS_BACKFILL_v2: the
-- migration ledger is keyed on FILENAME, so an earlier file's ADD COLUMN lines may
-- never have run against this database).
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS ref_code text,
  ADD COLUMN IF NOT EXISTS referrer_id uuid,
  -- The code a referred person CAME IN THROUGH. Kept separate from ref_code, which is
  -- that contact's OWN code and carries a UNIQUE index - see the fix in
  -- referralConversions.service.ts.
  ADD COLUMN IF NOT EXISTS referred_via_code text;

-- Backfill: anyone who was referred gets the 'referral' tag.
UPDATE contacts
   SET tags = coalesce(tags, '{}') || ARRAY['referral']::text[],
       updated_at = now()
 WHERE referrer_id IS NOT NULL
   AND NOT ('referral' = ANY(coalesce(tags, '{}')));

-- Backfill: anyone who signed up AS a referrer (a users row with role 'Referrer')
-- gets the 'referrer' tag on their matching CRM contact.
UPDATE contacts c
   SET tags = coalesce(c.tags, '{}') || ARRAY['referrer']::text[],
       updated_at = now()
  FROM users u
 WHERE u.role = 'Referrer'
   AND u.email IS NOT NULL
   AND lower(c.email) = lower(u.email)
   AND NOT ('referrer' = ANY(coalesce(c.tags, '{}')));
