-- BF_SERVER_SMS_CONSENT_v1
-- CASL requires the SENDER to prove consent. We had no consent record at all: the SMS
-- send only checked sms_opt_out (and ignored marketing_opt_out entirely).
--   express            -> Step 6 clause 3, no expiry
--   implied_transaction-> existing business relationship, 2 years from the transaction
--   implied_inquiry    -> they applied/enquired, 6 MONTHS from the inquiry
SET search_path = public, pg_catalog;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sms_consent          BOOLEAN;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_basis        TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_at           TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_consent ON contacts (consent_basis, consent_at);

-- Floor: everyone who ever applied has at least implied consent from the inquiry date.
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

-- BF_SERVER_EXPRESS_CONSENT_v1
-- Promote to express wherever the Communication Consent was actually recorded. Express
-- has no expiry and outranks the implied_inquiry floor above.
UPDATE contacts c
   SET sms_consent    = true,
       consent_basis  = 'express',
       consent_at     = COALESCE(x.applied_at, c.consent_at, now()),
       consent_source = 'backfill:application_step6'
  FROM (
    SELECT ac.contact_id, max(ap.created_at)::timestamptz AS applied_at
      FROM application_contacts ac
      JOIN applications ap ON ap.id = ac.application_id
     WHERE COALESCE(
             (ap.metadata #>> '{signature,communicationConsent}')::boolean,
             (ap.metadata #>> '{formData,communicationConsent}')::boolean,
             false
           ) = true
     GROUP BY ac.contact_id
  ) x
 WHERE x.contact_id = c.id;
