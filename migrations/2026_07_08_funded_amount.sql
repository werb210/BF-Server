-- BF_SERVER_FUNDED_AMOUNT_v1 - the actual amount the lender advanced, entered by staff when
-- an offer is confirmed. Distinct from requested_amount (what the client asked for) and from
-- offers.amount (what the term sheet quoted). All commission and ad-conversion value
-- calculations must use funded_amount when it is set.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS funded_amount NUMERIC(14,2);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS funded_at TIMESTAMPTZ;
