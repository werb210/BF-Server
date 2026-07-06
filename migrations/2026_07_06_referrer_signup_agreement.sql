-- BF_SERVER_REFERRER_SIGNUP_v1 - referrer self-signup + SignNow agreement gating.
-- A referrer is a users row with role 'Referrer'. Signup collects contact +
-- address (to pre-fill the agreement) + e-transfer email (20% commission
-- payout). referrer_status gates OTP login: only 'active' (agreement signed)
-- referrers may log in. We use a dedicated referrer_status column rather than
-- users.status so staff accounts are unaffected.
ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS street text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS province text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS etransfer_email text,
  ADD COLUMN IF NOT EXISTS referrer_status text,
  ADD COLUMN IF NOT EXISTS referrer_commission_rate numeric NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS agreement_document_group_id text,
  ADD COLUMN IF NOT EXISTS agreement_document_id text,
  ADD COLUMN IF NOT EXISTS agreement_signed_at timestamptz;

-- Any pre-existing Referrer users (created before self-signup) are treated as
-- already active so they are not locked out by the new gate.
UPDATE users SET referrer_status = 'active'
 WHERE role = 'Referrer' AND referrer_status IS NULL;
