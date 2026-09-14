-- BF_INBOUND_ATTACHMENT_ATTEMPT_LEDGER_v189
-- The inbound-attachment worker decided "have I handled this message?" by looking
-- for a row in contact_documents. A message whose attachments all get skipped
-- (itemAttachment/reference with no bytes, oversize, blob upload failure) writes
-- no row, so it was re-downloaded and re-attempted every 5 minutes for the whole
-- 2-day lookback window. This ledger records the attempt itself, so a message
-- that cannot be filed is retried a bounded number of times and then left alone.
CREATE TABLE IF NOT EXISTS inbound_attachment_attempts (
  silo              TEXT        NOT NULL,
  message_id        TEXT        NOT NULL,
  attempts          INTEGER     NOT NULL DEFAULT 0,
  last_outcome      TEXT,
  last_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (silo, message_id)
);

CREATE INDEX IF NOT EXISTS inbound_attachment_attempts_last_attempt_idx
  ON inbound_attachment_attempts (last_attempt_at);
