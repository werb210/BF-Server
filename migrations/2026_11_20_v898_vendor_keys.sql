-- BF_SERVER_v898_YOUR_SERVICES - Boreal's own keys for paid verification services, encrypted (src/integrations/vendorKeys.ts).
CREATE TABLE IF NOT EXISTS vendor_keys (
  key text PRIMARY KEY,
  value_enc text NOT NULL,
  key_name text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
