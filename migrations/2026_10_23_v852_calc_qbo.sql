-- BF_SERVER_v852_CALC_QBO - QuickBooks Online: the company connection (tokens encrypted by the server), the
-- single-use OAuth states, and one fee invoice per media application (also the retry outbox). Idempotent.
CREATE TABLE IF NOT EXISTS qbo_connections (
  id text PRIMARY KEY,
  realm_id text NOT NULL,
  environment text NOT NULL DEFAULT 'sandbox',
  access_token_enc text NOT NULL,
  refresh_token_enc text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  connected_by text,
  company_name text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  first_connected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qbo_oauth_states (
  state_hash text PRIMARY KEY,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS qbo_oauth_states_expires_idx ON qbo_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS qbo_fee_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  qbo_invoice_id text,
  doc_number text,
  qbo_customer_id text,
  amount numeric(14,2),
  status text NOT NULL DEFAULT 'pending',
  qbo_payment_id text,
  sync_state text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  last_error text,
  lease_until timestamptz,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE qbo_fee_invoices ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS qbo_fee_invoices_application_uidx ON qbo_fee_invoices (application_id);
CREATE INDEX IF NOT EXISTS qbo_fee_invoices_due_idx ON qbo_fee_invoices (sync_state, next_attempt_at);
