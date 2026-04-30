-- BF_SERVER_v70_BLOCK_1_1 — Option B Pending Acceptance staging.
-- Client clicks Accept -> pending_acceptance_offer_id is set (visible only
-- to staff). Staff Confirm in portal -> moves card to Accepted.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS pending_acceptance_offer_id UUID;
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS pending_acceptance_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_applications_pending_acceptance
  ON applications(pending_acceptance_offer_id)
  WHERE pending_acceptance_offer_id IS NOT NULL;
