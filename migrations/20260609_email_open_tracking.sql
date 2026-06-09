-- BF_SERVER_BLOCK_v797_EMAIL_OPEN_TRACKING — pixel-based open tracking + 24-business-hour
-- follow-up notifications. opened_at already exists (stamped by the v706 read-receipt
-- worker and now also by the tracking pixel). Adds pixel_token + followup_notified_at.
-- Backfills followup_notified_at on existing rows so the follow-up worker only fires for
-- emails sent AFTER this deploy (no notification spam on the historical backlog).
ALTER TABLE crm_email_log ADD COLUMN IF NOT EXISTS opened_at            timestamptz;
ALTER TABLE crm_email_log ADD COLUMN IF NOT EXISTS pixel_token          text;
ALTER TABLE crm_email_log ADD COLUMN IF NOT EXISTS followup_notified_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_crm_email_log_pixel_token ON crm_email_log (pixel_token);
CREATE INDEX IF NOT EXISTS idx_crm_email_log_followup    ON crm_email_log (opened_at, followup_notified_at, created_at);
UPDATE crm_email_log SET followup_notified_at = now() WHERE followup_notified_at IS NULL;
