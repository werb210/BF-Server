-- BF_SERVER_BROKER_PORTAL_v717
-- Brokers are partner accounts like referrers (same sign-up, SignNow agreement and
-- phone-code login) marked partner_kind = 'broker'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS partner_kind text NOT NULL DEFAULT 'referrer';
CREATE INDEX IF NOT EXISTS broker_imports_broker_user_idx ON broker_imports (broker_user_id);
