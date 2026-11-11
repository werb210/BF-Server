-- BF_SERVER_v938_OFFER_PRICING - each offer's pricing (Todd and Andrew, Nov 11 2026):
--   term_sheet_mode  lender = the client signs the lender's term sheet (lender named);
--                    ours   = we buy the deal and the client signs our term sheet (no lender name).
--   client_rate      the rate (or factor) we offer the client; the lender's stays in rate_factor. The difference is ours.
--   broker_fee / setup_fee / proceeds_fee   fees to us; proceeds_fee is paid out of the loan proceeds.
--   lender_commission what the lender pays us on funding, when known.
-- lender_term_sheet_blob_name keeps the lender's own PDF when our term sheet replaces it (same as Keystone).
ALTER TABLE offers ADD COLUMN IF NOT EXISTS term_sheet_mode text NOT NULL DEFAULT 'lender';
ALTER TABLE offers ADD COLUMN IF NOT EXISTS client_rate numeric(12,4);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS term_months integer;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS broker_fee numeric(14,2);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS setup_fee numeric(14,2);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS proceeds_fee numeric(14,2);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS lender_commission numeric(14,2);
ALTER TABLE offers ADD COLUMN IF NOT EXISTS pricing_updated_at timestamptz;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS lender_term_sheet_blob_name text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offers_term_sheet_mode_check') THEN
    ALTER TABLE offers ADD CONSTRAINT offers_term_sheet_mode_check CHECK (term_sheet_mode IN ('lender', 'ours'));
  END IF;
END $$;
