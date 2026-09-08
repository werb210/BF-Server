-- BF_SERVER_PORTAL_ERRORS_v1
-- Portal crashes were headed for the applicant-facing report table, whose
-- schema drops the stack trace. Separate table: staff-side, keeps diagnostics,
-- never appears in the customer triage queue.
CREATE TABLE IF NOT EXISTS portal_errors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint   text NOT NULL,
  source        text NOT NULL,
  message       text NOT NULL,
  stack         text,
  url           text,
  user_agent    text,
  user_id       text,
  silo          text NOT NULL DEFAULT 'BF',
  context       jsonb,
  occurrences   integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per distinct error, not one per occurrence: a render loop throws
-- hundreds of times and all of them are the same defect.
CREATE UNIQUE INDEX IF NOT EXISTS portal_errors_fingerprint_idx
  ON portal_errors (fingerprint);
CREATE INDEX IF NOT EXISTS portal_errors_recent_idx
  ON portal_errors (last_seen_at DESC);
