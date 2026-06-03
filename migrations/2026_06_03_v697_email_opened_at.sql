-- BF_SERVER_BLOCK_v706_READ_RECEIPTS — read-receipt timestamp for sent emails.
ALTER TABLE crm_email_log ADD COLUMN IF NOT EXISTS opened_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_crm_email_log_opened ON crm_email_log (owner_id, opened_at);
