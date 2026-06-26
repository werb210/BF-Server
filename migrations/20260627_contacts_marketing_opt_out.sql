-- BF_SERVER_CONTACTS_MARKETING_OPT_OUT_v1
-- Durable email suppression for CASL: set true on unsubscribe/bounce/spam.
ALTER TABLE IF EXISTS contacts
  ADD COLUMN IF NOT EXISTS marketing_opt_out boolean NOT NULL DEFAULT false;
