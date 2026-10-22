-- BF_SERVER_v846_FRAUD - the fraud-detection suite (ported from Keystone). Every check's result, the queue the fraud worker reads, document
-- fingerprints, the client app's device and behaviour signals, staff-risk events and what was shared with the
-- Keystone watchlist. Safe to run again. (No live-bank table: Boreal does not use Flinks, so there is no check 3.)
--
-- Privacy: identifiers are stored as keyed hashes (HMAC-SHA256) wherever equality is all a check needs (device id,
-- IP address, answers fingerprint, watchlist entries). No keystrokes, no raw IP addresses, no images of IDs.

-- One row per (application, check, subject). subject = '' for an application-level check, a document id for a
-- per-document check, a recording id for a call check. Re-running a check replaces its row.
CREATE TABLE IF NOT EXISTS fraud_check_results (
  id bigserial PRIMARY KEY,
  application_id text NOT NULL,
  check_key text NOT NULL,
  subject text NOT NULL DEFAULT '',
  status text NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fraud_check_results_uq ON fraud_check_results (application_id, check_key, subject);
CREATE INDEX IF NOT EXISTS fraud_check_results_app_idx ON fraud_check_results (application_id);

-- The fraud worker's queue: one row per application. requested_at moves forward each time something new arrives
-- (a document, banking results, device signals, a staff "run again"); the worker runs when done_at < requested_at.
CREATE TABLE IF NOT EXISTS fraud_queue (
  application_id text PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  done_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);
CREATE INDEX IF NOT EXISTS fraud_queue_due_idx ON fraud_queue (next_attempt_at);

-- Fingerprints of each uploaded file: the exact SHA-256 and perceptual hashes (64-bit dHash, hex) of the file's
-- images (a photo, or the scanned page images inside a PDF). Used to spot the same file, ID or void cheque on
-- another application. id_kind = 'id' | 'void_cheque' | 'other' from the document category.
CREATE TABLE IF NOT EXISTS document_fingerprints (
  document_id text PRIMARY KEY,
  application_id text NOT NULL,
  sha256 text,
  phashes text[] NOT NULL DEFAULT '{}',
  id_kind text NOT NULL DEFAULT 'other',
  image_info jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_fingerprints_sha_idx ON document_fingerprints (sha256);
CREATE INDEX IF NOT EXISTS document_fingerprints_app_idx ON document_fingerprints (application_id);

-- Device, location and behaviour signals the client app sends with an application (aggregates only).
-- device_hash / ip_hash / answers_hash are HMACs; ip_country / ip_region / asn come from the IP provider when set.
CREATE TABLE IF NOT EXISTS fraud_device_signals (
  application_id text PRIMARY KEY,
  device_hash text,
  ip_hash text,
  ip_country text,
  ip_region text,
  asn text,
  asn_org text,
  ip_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_provider text,
  behaviour jsonb NOT NULL DEFAULT '{}'::jsonb,
  answers_hash text,
  platform text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fraud_device_signals_device_idx ON fraud_device_signals (device_hash);
CREATE INDEX IF NOT EXISTS fraud_device_signals_ip_idx ON fraud_device_signals (ip_hash);
CREATE INDEX IF NOT EXISTS fraud_device_signals_answers_idx ON fraud_device_signals (answers_hash);

-- Inside-job alerts: staff actions worth a second look (banking details changed on a file, bulk exports, approving
-- a file they submitted, unusual hours or volume). alerted_at is set once the Admins were told.
CREATE TABLE IF NOT EXISTS staff_risk_events (
  id bigserial PRIMARY KEY,
  user_id text,
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'amber',
  application_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  alerted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_risk_events_dedupe_uq ON staff_risk_events (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS staff_risk_events_created_idx ON staff_risk_events (created_at);
CREATE INDEX IF NOT EXISTS staff_risk_events_user_idx ON staff_risk_events (user_id, created_at);

-- The two Admin settings (watchlist opt-in, pre-screen default) live in the settings table (keys fraud.*); no table here.

-- What Boreal shared with the watchlist, per confirmed-fraud application (so it is sent once, and withdrawn
-- if the file is restored out of Fraud). Only hashes are kept.
CREATE TABLE IF NOT EXISTS fraud_watchlist_shares (
  application_id text PRIMARY KEY,
  application_ref text NOT NULL,
  entry_count integer NOT NULL DEFAULT 0,
  shared_at timestamptz,
  withdrawn_at timestamptz,
  last_attempt_at timestamptz,
  last_error text
);

-- Per-application choice: add the fraud pre-screen summary to the lender package.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS fraud_prescreen_in_package boolean;
