-- BF_SERVER_v910_EMAIL_CONSENT - email marketing consent recorded on its own, separate from texting consent. Before
-- this, email campaigns only reached contacts with TEXT consent (sms_consent / consent_basis), so marketing contacts
-- imported for email were left out. Safe to run again.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_consent_basis text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_consent_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_consent_source text;
CREATE INDEX IF NOT EXISTS contacts_email_consent_idx ON contacts (silo, email_consent_basis) WHERE email_consent_basis IS NOT NULL;
