-- Per-lender competing offers: each lender's term sheet becomes its own offer,
-- shown side-by-side to the client. lender_id ties an offer to the lender row;
-- the partial index supports "one active offer per (application, lender)".
ALTER TABLE offers ADD COLUMN IF NOT EXISTS lender_id UUID;
CREATE INDEX IF NOT EXISTS idx_offers_application_lender_active
  ON offers(application_id, lender_id) WHERE is_archived = FALSE;
