-- BF_SERVER_BANKING_INTEGRITY_v44
ALTER TABLE banking_transactions ADD COLUMN IF NOT EXISTS currency_code text;
ALTER TABLE banking_transactions ADD COLUMN IF NOT EXISTS account_key text;
ALTER TABLE banking_analyses ADD COLUMN IF NOT EXISTS integrity_report jsonb NOT NULL DEFAULT '{}'::jsonb;
