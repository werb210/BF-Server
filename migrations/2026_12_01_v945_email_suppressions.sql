-- BF_SERVER_v945_EMAIL_SUPPRESSIONS - an unsubscribe, spam report or hard bounce is remembered by ADDRESS, not only on
-- the contact it matched. Before this, an event for an address with no contact was dropped, so a later import of that
-- address created a contact who could be emailed again (an anti-spam problem), and when several contacts shared an
-- address only one was opted out.
--   email_suppressions      one row per address that must not get marketing email, with why and when
--   bf_contact_suppressed   a contact created with, or changed to, a suppressed address is opted out at once.
--                           Staff can still opt a contact back in afterwards (the trigger only acts when the
--                           address is new to the contact), for someone who asks to be re-subscribed.
-- Safe to run again.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email text PRIMARY KEY,
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'sendgrid',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  events integer NOT NULL DEFAULT 1
);

CREATE OR REPLACE FUNCTION bf_contact_suppressed() RETURNS trigger AS $$
BEGIN
  -- Keystone prospects (silo KS) are mailed by a separate sender with its own suppression list in KS-Ops.
  IF coalesce(NEW.silo, 'BF') <> 'KS' AND EXISTS (
    SELECT 1 FROM email_suppressions s
     WHERE s.email IN (lower(trim(coalesce(NEW.email, ''))), lower(trim(coalesce(NEW.secondary_email, '')))) AND s.email <> ''
  ) THEN
    NEW.marketing_opt_out := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bf_contact_suppressed_ins ON contacts;
CREATE TRIGGER bf_contact_suppressed_ins BEFORE INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION bf_contact_suppressed();
DROP TRIGGER IF EXISTS bf_contact_suppressed_upd ON contacts;
CREATE TRIGGER bf_contact_suppressed_upd BEFORE UPDATE OF email, secondary_email ON contacts
  FOR EACH ROW WHEN (NEW.email IS DISTINCT FROM OLD.email OR NEW.secondary_email IS DISTINCT FROM OLD.secondary_email)
  EXECUTE FUNCTION bf_contact_suppressed();

-- Carry forward what is already known: every address of a contact that is opted out today.
INSERT INTO email_suppressions (email, reason, source)
SELECT DISTINCT e, 'opted out before the suppression list existed', 'backfill'
  FROM contacts c, LATERAL (VALUES (lower(trim(coalesce(c.email, '')))), (lower(trim(coalesce(c.secondary_email, ''))))) v(e)
 WHERE c.marketing_opt_out = true AND coalesce(c.silo, 'BF') <> 'KS' AND e <> '' AND position('@' in e) > 1
ON CONFLICT (email) DO NOTHING;
