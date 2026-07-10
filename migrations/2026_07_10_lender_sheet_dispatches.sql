-- BF_SERVER_GSHEET_ROW_v1
-- Idempotency ledger for Google Sheet lender submissions. A row is claimed
-- before the sheet append; a worker retry that finds the claim already present
-- skips the append, so a resubmit/retry cannot write a duplicate row into the
-- lender's sheet. Additive / IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS lender_sheet_dispatches (
  application_id TEXT NOT NULL,
  lender_id      TEXT NOT NULL,
  appended_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, lender_id)
);
