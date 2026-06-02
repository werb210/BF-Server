-- BF_SERVER_BLOCK_v731 — per-team-mailbox signatures
ALTER TABLE shared_mailbox_settings ADD COLUMN IF NOT EXISTS signature_html TEXT;
