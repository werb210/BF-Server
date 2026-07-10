-- BF_SERVER_REFERRAL_CROSS_SILO_v1 - additive cross-silo referral invites and conversion ledger.
ALTER TABLE IF EXISTS contacts
  ADD COLUMN IF NOT EXISTS ref_code text,
  ADD COLUMN IF NOT EXISTS referral_silos text[] NOT NULL DEFAULT ARRAY['BF']::text[],
  ADD COLUMN IF NOT EXISTS referral_invite_message text,
  ADD COLUMN IF NOT EXISTS referral_invited_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_ref_code_uidx
  ON contacts (ref_code)
  WHERE ref_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NULL,
  contact_id uuid NULL,
  referrer_id uuid NOT NULL,
  ref_code text NULL,
  source_silo text NOT NULL DEFAULT 'BF',
  external_application_id text NULL,
  conversion_rate numeric NOT NULL DEFAULT 20,
  deal_amount numeric NULL,
  credit_amount numeric NULL,
  status text NOT NULL DEFAULT 'credited',
  credited_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS referral_conversions_application_uidx
  ON referral_conversions (application_id)
  WHERE application_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS referral_conversions_external_uidx
  ON referral_conversions (source_silo, external_application_id)
  WHERE external_application_id IS NOT NULL;
