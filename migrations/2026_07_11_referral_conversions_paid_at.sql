-- BF_SERVER_REFERRER_PAYOUT_v1 - stamp when a conversion is paid out. Additive.
ALTER TABLE referral_conversions ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
