-- BF_SERVER_BLOCK_v494_LENDER_EMAIL_BOUNCES - bounce notices (NDRs) that came back
-- to the send-as mailbox for lender package emails. Idempotent.
CREATE TABLE IF NOT EXISTS lender_email_bounces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ndr_message_id  TEXT NOT NULL,
  application_id  TEXT,
  lender_id       UUID,
  recipient       TEXT,
  reason          TEXT NOT NULL,
  detail          TEXT,
  received_at     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_lender_email_bounces_ndr ON lender_email_bounces(ndr_message_id);
CREATE INDEX IF NOT EXISTS idx_lender_email_bounces_app ON lender_email_bounces(application_id, lender_id);
