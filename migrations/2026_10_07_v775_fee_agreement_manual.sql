-- BF_SERVER_FEE_MANUAL_SIGN_v775 - staff can record a client fee agreement signed outside the portal
-- (a negotiated version signed by hand), with what was agreed.
ALTER TABLE media_fee_agreements ADD COLUMN IF NOT EXISTS signed_manually BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE media_fee_agreements ADD COLUMN IF NOT EXISTS manual_signed_by TEXT;
ALTER TABLE media_fee_agreements ADD COLUMN IF NOT EXISTS manual_note TEXT;
ALTER TABLE media_fee_agreements ADD COLUMN IF NOT EXISTS fee_percent NUMERIC(6,3);
ALTER TABLE media_fee_agreements ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(14,2);
