-- BF_SERVER_UNIVERSAL_SUPPRESSION_v1 - one do-not-email list for every business. Keystone's CRM people are now
-- emailed by this server's flows too, so an address on email_suppressions opts out a contact in any silo.
-- Safe to run again.
CREATE OR REPLACE FUNCTION bf_contact_suppressed() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM email_suppressions s
     WHERE s.email IN (lower(trim(coalesce(NEW.email, ''))), lower(trim(coalesce(NEW.secondary_email, '')))) AND s.email <> ''
  ) THEN
    NEW.marketing_opt_out := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

UPDATE contacts c SET marketing_opt_out = true, updated_at = now()
 WHERE c.marketing_opt_out = false AND EXISTS (
   SELECT 1 FROM email_suppressions s
    WHERE s.email IN (lower(trim(coalesce(c.email, ''))), lower(trim(coalesce(c.secondary_email, '')))) AND s.email <> '');
