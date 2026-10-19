-- BF_SERVER_v825_LENDER_REFERRALS - files lenders send from the lender portal (deals they declined). One row per
-- client zip. The zip is kept here until staff accept (it is then imported like a broker file) or decline (deleted).
-- Idempotent: safe to run again.
CREATE TABLE IF NOT EXISTS lender_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_id text NOT NULL,
  lender_name text NULL,
  uploaded_by text NULL,
  business_name text NOT NULL,
  client_name text NULL,
  client_phone text NOT NULL,
  requested_amount numeric(14,2) NULL,
  decline_reason text NULL,
  zip_name text NOT NULL,
  zip_data bytea NULL,
  zip_size integer NULL,
  file_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  complete_package boolean NULL,
  decision_note text NULL,
  decided_by text NULL,
  decided_at timestamptz NULL,
  application_id text NULL,
  import_id text NULL,
  client_texted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lender_referrals_lender_idx ON lender_referrals (lender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lender_referrals_status_idx ON lender_referrals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS lender_referrals_application_idx ON lender_referrals (application_id) WHERE application_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lender_referrals_status_chk') THEN
    ALTER TABLE lender_referrals ADD CONSTRAINT lender_referrals_status_chk CHECK (status IN ('pending', 'accepting', 'accepted', 'declined'));
  END IF;
END $$;
