-- BF_SERVER_v875_INTEGRATIONS - batch 8: outgoing webhooks (Zapier), API keys with a scoped public API, and Microsoft
-- single sign-on for staff. Ported from KS-server #35 and #39 without the plan gates. Safe to run again.

-- 1. Outgoing webhooks ------------------------------------------------------------------------------------------------
-- An endpoint belongs to one silo and only hears that silo's events. batch_size 1 sends one event per request; more
-- sends the events that are due together as one JSON array (a Zapier Catch Hook runs the Zap once per item).
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  url text NOT NULL,
  description text,
  events text[] NOT NULL DEFAULT '{}'::text[],
  batch_size integer NOT NULL DEFAULT 1,
  -- active | paused (by an admin) | disabled (by the server after repeated failures)
  status text NOT NULL DEFAULT 'active',
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  disabled_reason text,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS batch_size integer NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_endpoints_status_check') THEN
    ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_status_check CHECK (status IN ('active', 'paused', 'disabled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_endpoints_batch_size_check') THEN
    ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_batch_size_check CHECK (batch_size BETWEEN 1 AND 100);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS webhook_endpoints_active_idx ON webhook_endpoints (silo) WHERE status = 'active';

-- Signing secrets apart from the endpoint rows (kept out of exports, which skip *_secrets tables).
CREATE TABLE IF NOT EXISTS webhook_endpoint_secrets (
  endpoint_id uuid PRIMARY KEY REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The durable outbox. status: pending | sending (claimed by the worker) | succeeded | dead (gave up) | skipped (the
-- endpoint was paused, disabled or deleted before it went out).
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  silo text,
  event_type text NOT NULL,
  object_type text,
  object_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  last_attempt_at timestamptz,
  last_status_code integer,
  last_error text,
  last_duration_ms integer,
  delivered_at timestamptz,
  resend_of uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON webhook_deliveries (created_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_object_idx ON webhook_deliveries (object_id);

-- One delivery per active endpoint of the silo subscribed to the event. Never raises: a webhook problem must not fail
-- the contact, application, document, offer or note write that fired it.
CREATE OR REPLACE FUNCTION bf_webhook_enqueue(p_silo text, p_event text, p_object_type text, p_object_id text, p_object jsonb, p_extra jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_event_id uuid;
  v_silo text := upper(COALESCE(NULLIF(p_silo, ''), 'BF'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM webhook_endpoints WHERE status = 'active' AND silo = v_silo AND p_event = ANY(events)) THEN
    RETURN;
  END IF;
  v_event_id := gen_random_uuid();
  INSERT INTO webhook_deliveries (event_id, endpoint_id, silo, event_type, object_type, object_id, payload, occurred_at)
  SELECT v_event_id, e.id, v_silo, p_event, p_object_type, p_object_id,
         jsonb_build_object('object', p_object, 'extra', COALESCE(p_extra, '{}'::jsonb)), now()
    FROM webhook_endpoints e
   WHERE e.status = 'active' AND e.silo = v_silo AND p_event = ANY(e.events);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'bf_webhook_enqueue % failed: %', p_event, SQLERRM;
END
$$;

-- Columns never stored in a delivery (secrets, large internals). What is sent is narrowed further in
-- src/outboundWebhooks/events.ts.
CREATE OR REPLACE FUNCTION bf_webhook_row(p_row jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT p_row - ARRAY['ssn_encrypted', 'dob', 'metadata', 'ocr_missing_fields', 'ocr_conflicting_fields', 'ocr_normalized_values',
                       'lender_matches', 'lender_matches_inputs', 'lender_matches_missing_inputs', 'fraud_evidence',
                       'tamper_signals', 'onedrive_folder_id', 'onedrive_drive_id', 'storage_key', 'storage_path',
                       'blob_name', 'blob_url', 'file_url', 'object_key', 'hash', 'term_sheet_blob_name', 'document_url']
$$;

CREATE OR REPLACE FUNCTION bf_webhook_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ignore text[] := ARRAY['updated_at', 'last_updated', 'line_type', 'line_type_checked_at', 'outlook_contact_id',
                           'onedrive_folder_id', 'onedrive_drive_id', 'onedrive_folder_url', 'last_portal_seen_at'];
  v_new jsonb;
  v_old jsonb;
  v_silo text;
BEGIN
  -- Cheap exit when nobody listens (one indexed lookup).
  IF NOT EXISTS (SELECT 1 FROM webhook_endpoints WHERE status = 'active') THEN
    RETURN NULL;
  END IF;
  v_new := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'contacts' THEN
    v_silo := v_new->>'silo';
    IF TG_OP = 'INSERT' THEN
      PERFORM bf_webhook_enqueue(v_silo, 'contact.created', 'contact', NEW.id::text, bf_webhook_row(v_new), NULL);
    ELSE
      v_old := to_jsonb(OLD);
      IF (v_new - v_ignore) IS DISTINCT FROM (v_old - v_ignore) THEN
        PERFORM bf_webhook_enqueue(v_silo, 'contact.updated', 'contact', NEW.id::text, bf_webhook_row(v_new), NULL);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'companies' THEN
    v_silo := v_new->>'silo';
    IF TG_OP = 'INSERT' THEN
      PERFORM bf_webhook_enqueue(v_silo, 'company.created', 'company', NEW.id::text, bf_webhook_row(v_new), NULL);
    ELSE
      v_old := to_jsonb(OLD);
      IF (v_new - v_ignore) IS DISTINCT FROM (v_old - v_ignore) THEN
        PERFORM bf_webhook_enqueue(v_silo, 'company.updated', 'company', NEW.id::text, bf_webhook_row(v_new), NULL);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'applications' THEN
    v_silo := v_new->>'silo';
    IF TG_OP = 'INSERT' THEN
      PERFORM bf_webhook_enqueue(v_silo, 'application.created', 'application', NEW.id::text, bf_webhook_row(v_new), NULL);
    ELSE
      v_old := to_jsonb(OLD);
      IF (v_new->>'pipeline_state') IS DISTINCT FROM (v_old->>'pipeline_state') THEN
        PERFORM bf_webhook_enqueue(v_silo, 'application.stage_changed', 'application', NEW.id::text, bf_webhook_row(v_new),
          jsonb_build_object('from_stage', v_old->>'pipeline_state', 'to_stage', v_new->>'pipeline_state'));
      END IF;
      IF (v_old->>'signnow_app_signed_at') IS NULL AND (v_new->>'signnow_app_signed_at') IS NOT NULL THEN
        PERFORM bf_webhook_enqueue(v_silo, 'application.signed', 'application', NEW.id::text, bf_webhook_row(v_new), NULL);
      END IF;
      -- Funded once: the funded date is first set while the file was not already Funded, or the file first moves to
      -- Funded before any funded date was recorded.
      IF ((v_old->>'funded_at') IS NULL AND (v_new->>'funded_at') IS NOT NULL AND (v_old->>'pipeline_state') IS DISTINCT FROM 'Funded')
         OR ((v_new->>'pipeline_state') = 'Funded' AND (v_old->>'pipeline_state') IS DISTINCT FROM 'Funded' AND (v_old->>'funded_at') IS NULL) THEN
        PERFORM bf_webhook_enqueue(v_silo, 'deal.funded', 'application', NEW.id::text, bf_webhook_row(v_new), NULL);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'documents' THEN
    SELECT a.silo INTO v_silo FROM applications a WHERE a.id = NEW.application_id;
    PERFORM bf_webhook_enqueue(v_silo, 'document.uploaded', 'document', NEW.id::text, bf_webhook_row(v_new), NULL);
  ELSIF TG_TABLE_NAME = 'offers' THEN
    SELECT a.silo INTO v_silo FROM applications a WHERE a.id = NEW.application_id;
    IF TG_OP = 'INSERT' THEN
      PERFORM bf_webhook_enqueue(v_silo, 'offer.created', 'offer', NEW.id::text, bf_webhook_row(v_new), NULL);
    ELSE
      v_old := to_jsonb(OLD);
      IF (v_new->>'status') IS DISTINCT FROM (v_old->>'status') THEN
        PERFORM bf_webhook_enqueue(v_silo, 'offer.status_changed', 'offer', NEW.id::text, bf_webhook_row(v_new),
          jsonb_build_object('from_status', v_old->>'status', 'to_status', v_new->>'status'));
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'crm_notes' THEN
    v_silo := v_new->>'silo';
    PERFORM bf_webhook_enqueue(v_silo, 'note.added', 'note', NEW.id::text, bf_webhook_row(v_new), NULL);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'bf_webhook_capture on % failed: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS bf_webhook_contacts ON contacts;
CREATE TRIGGER bf_webhook_contacts AFTER INSERT OR UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION bf_webhook_capture();
DROP TRIGGER IF EXISTS bf_webhook_companies ON companies;
CREATE TRIGGER bf_webhook_companies AFTER INSERT OR UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION bf_webhook_capture();
DROP TRIGGER IF EXISTS bf_webhook_applications ON applications;
CREATE TRIGGER bf_webhook_applications AFTER INSERT OR UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION bf_webhook_capture();
DROP TRIGGER IF EXISTS bf_webhook_documents ON documents;
CREATE TRIGGER bf_webhook_documents AFTER INSERT ON documents FOR EACH ROW EXECUTE FUNCTION bf_webhook_capture();
DROP TRIGGER IF EXISTS bf_webhook_offers ON offers;
CREATE TRIGGER bf_webhook_offers AFTER INSERT OR UPDATE ON offers FOR EACH ROW EXECUTE FUNCTION bf_webhook_capture();
DROP TRIGGER IF EXISTS bf_webhook_crm_notes ON crm_notes;
CREATE TRIGGER bf_webhook_crm_notes AFTER INSERT ON crm_notes FOR EACH ROW EXECUTE FUNCTION bf_webhook_capture();

-- 2. API keys -----------------------------------------------------------------------------------------------------------
-- The key is shown once; only an HMAC-SHA256 of it is kept (pepper: API_KEY_PEPPER, or the server's JWT secret when
-- that is unset - pepper_source records which, so setting the pepper later keeps old keys working). A key belongs to
-- one silo and carries per-area scopes such as contacts:read or applications:write.
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  silo text NOT NULL DEFAULT 'BF',
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  key_prefix text NOT NULL,
  key_hash text NOT NULL,
  pepper_source text NOT NULL DEFAULT 'env',
  rate_limit_per_minute integer NOT NULL DEFAULT 120,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  last_used_ip text,
  revoked_at timestamptz,
  revoked_by uuid
);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_per_minute integer NOT NULL DEFAULT 120;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_ip text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_rate_limit_check') THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_rate_limit_check CHECK (rate_limit_per_minute BETWEEN 1 AND 6000);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS api_keys_active_idx ON api_keys (silo, created_at DESC) WHERE revoked_at IS NULL;

-- 3. Microsoft single sign-on ------------------------------------------------------------------------------------------
-- The switch lives in boreal_settings (key 'sso'). Single-use sign-in state: sha256 of the state value, the PKCE
-- verifier and the id_token nonce, 10-minute life.
CREATE TABLE IF NOT EXISTS sso_login_states (
  state_hash text PRIMARY KEY,
  provider text NOT NULL,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sso_login_states_expires_idx ON sso_login_states (expires_at);

-- One-time hand-off from the callback to the portal: sha256 of a 60-second code, exchanged once for a session.
CREATE TABLE IF NOT EXISTS sso_login_handoffs (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL,
  provider text NOT NULL,
  email text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sso_login_handoffs_expires_idx ON sso_login_handoffs (expires_at);
