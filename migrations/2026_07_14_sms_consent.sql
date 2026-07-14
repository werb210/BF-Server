-- BF_SERVER_SMS_CONSENT_v1
-- CASL requires the SENDER to prove consent. We had no consent record at all: the SMS
-- send only checked sms_opt_out (and ignored marketing_opt_out entirely).
--   express            -> checkbox on the application form, no expiry
--   implied_transaction-> existing business relationship, 2 years from the transaction
--   implied_inquiry    -> they applied/enquired, 6 MONTHS from the inquiry
SET search_path = public, pg_catalog;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_consent          BOOLEAN;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_basis        TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_at           TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_consent ON contacts (consent_basis, consent_at);

-- Backfill from the application history. applications.created_at via application_contacts
-- is the inquiry date -- the only defensible evidence we currently hold.
UPDATE contacts c
   SET consent_basis  = 'implied_inquiry',
       consent_at     = a.last_applied,
       consent_source = 'backfill:application'
  FROM (
    SELECT ac.contact_id, max(ap.created_at)::timestamptz AS last_applied
      FROM application_contacts ac
      JOIN applications ap ON ap.id = ac.application_id
     GROUP BY ac.contact_id
  ) a
 WHERE a.contact_id = c.id
   AND c.consent_basis IS NULL;
