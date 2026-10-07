-- BF_SERVER_READ_THIS_v776 - "Read this" team messages with read receipts.
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS read_this BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS team_message_reads (
  message_id uuid NOT NULL,
  user_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
-- BF_SERVER_STAFF_LIBRARY_v776 - the company-wide "Boreal Staff Library" OneDrive folder (one row).
CREATE TABLE IF NOT EXISTS staff_library (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  drive_id text,
  item_id text NOT NULL,
  share_url text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- BF_SERVER_REPORTS_BATCH5_v776 - commission Boreal has actually received from the lender.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS commission_received_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS commission_received_amount NUMERIC;
