-- BF_SERVER_BROKER_SPLIT_LOCK_v716
-- Broker files: the commission split is proposed by Boreal, accepted (or countered)
-- by the broker, and locked before any lender submission. Payouts are tracked.
ALTER TABLE broker_deal_confirmations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'proposed';
ALTER TABLE broker_deal_confirmations ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE broker_deal_confirmations ADD COLUMN IF NOT EXISTS broker_counter_pct numeric;
ALTER TABLE broker_deal_confirmations ADD COLUMN IF NOT EXISTS broker_counter_note text;
ALTER TABLE broker_deal_confirmations ADD COLUMN IF NOT EXISTS payout_amount numeric;
ALTER TABLE broker_deal_confirmations ADD COLUMN IF NOT EXISTS payout_paid_on date;
ALTER TABLE broker_imports ADD COLUMN IF NOT EXISTS broker_user_id text;
-- Splits recorded before this block were entered by staff after the broker agreed.
UPDATE broker_deal_confirmations SET status = 'accepted', accepted_at = COALESCE(accepted_at, updated_at, created_at)
 WHERE status = 'proposed' AND agreed_by_broker IS NOT NULL AND accepted_at IS NULL;
