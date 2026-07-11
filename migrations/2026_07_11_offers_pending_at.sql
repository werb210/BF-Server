-- BF_SERVER_OFFERS_PENDING_AT_v1
-- offerAcceptance writes offers.pending_at and status='pending_acceptance'; neither
-- existed, so acceptance threw 42703 (missing column) and would then violate the
-- status check. Add the column and widen the constraint. Additive + idempotent.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS pending_at TIMESTAMPTZ;

ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_status_check;
ALTER TABLE offers ADD CONSTRAINT offers_status_check
  CHECK (status IN ('pending','accepted','rejected','changes_requested','pending_acceptance'));
