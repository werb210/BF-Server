-- BF_SERVER_BRAND_UNSUBSCRIBES_v1 - unsubscribing from one brand (Boreal Financial, Keystone, SLF) does not stop the others,
-- unless the person asks to stop all email. email_suppressions.brands says which brands an address must not get:
-- NULL = every brand (hard bounce, spam complaint, a global "stop all email" unsubscribe); otherwise the silos listed.
-- Safe to run again.
ALTER TABLE email_suppressions ADD COLUMN IF NOT EXISTS brands text[];

-- Earlier unsubscribes recorded by this server were from Boreal Financial mail.
UPDATE email_suppressions SET brands = ARRAY['BF']
 WHERE brands IS NULL AND reason IN ('unsubscribe', 'group_unsubscribe') AND source = 'sendgrid';

CREATE OR REPLACE FUNCTION bf_contact_suppressed() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM email_suppressions s
     WHERE s.email IN (lower(trim(coalesce(NEW.email, ''))), lower(trim(coalesce(NEW.secondary_email, '')))) AND s.email <> ''
       AND (s.brands IS NULL OR coalesce(NEW.silo, 'BF') = ANY (s.brands))
  ) THEN
    NEW.marketing_opt_out := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Keystone contacts opted out only because of a Boreal Financial unsubscribe get their marketing back (the universal
-- suppression change of 2026-12-16 had not been released when this was written; this undoes it if it ran).
UPDATE contacts c SET marketing_opt_out = false, updated_at = now()
 WHERE c.marketing_opt_out = true AND coalesce(c.silo, 'BF') <> 'BF'
   AND EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email IN (lower(trim(coalesce(c.email, ''))), lower(trim(coalesce(c.secondary_email, '')))) AND s.email <> '' AND s.brands = ARRAY['BF'])
   AND NOT EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email IN (lower(trim(coalesce(c.email, ''))), lower(trim(coalesce(c.secondary_email, '')))) AND s.email <> '' AND (s.brands IS NULL OR coalesce(c.silo, 'BF') = ANY (s.brands)))
   AND c.updated_at > timestamptz '2026-11-24';
