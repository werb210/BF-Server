-- BF_SERVER_v827_REFERRAL_PIPELINE_CARD - why a lender referral's zip could not be imported (shown to staff).
-- Idempotent: safe to run again.
ALTER TABLE lender_referrals ADD COLUMN IF NOT EXISTS import_error text NULL;
