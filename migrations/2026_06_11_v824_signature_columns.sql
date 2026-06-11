-- BF_SERVER_BLOCK_v824_PER_ACCOUNT_SIGNATURE — ensure signature columns exist.
ALTER TABLE shared_mailbox_settings ADD COLUMN IF NOT EXISTS signature_html TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS email_signature_html TEXT;
