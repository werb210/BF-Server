-- BF_SERVER_BLOCK_v842_SUBMIT_ATTEMPTS
-- Server-side record of every client submit ATTEMPT, written the instant the
-- client taps Submit (before any fragile client work). Rows that never reach
-- status 'completed' are submissions that died in the browser and never arrived
-- — the previously-invisible failures behind "some applications, not all".
CREATE TABLE IF NOT EXISTS submit_attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_token text UNIQUE,
  phone             text,
  email             text,
  business_name     text,
  status            text NOT NULL DEFAULT 'attempted',
  error             text,
  user_agent        text,
  silo              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS submit_attempts_status_created_idx
  ON submit_attempts (status, created_at DESC);
