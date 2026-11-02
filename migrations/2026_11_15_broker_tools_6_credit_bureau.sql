-- BROKER_TOOLS_6_CREDIT_BUREAU - consumer / commercial credit bureau pulls (Equifax Canada, TransUnion Canada) behind a
-- provider interface: the applicant's consent (given in the client app, or recorded by an Admin from a signed form),
-- each pull with its key fields and the report PDF. Idempotent.
-- BF_SERVER_v879_NO_PGCRYPTO - pgcrypto is not allow-listed on Azure Database for PostgreSQL; gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE IF NOT EXISTS credit_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  subject_kind text NOT NULL DEFAULT 'person',
  subject jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'requested',
  consent_text text NOT NULL,
  method text,
  given_name text,
  given_at timestamptz,
  ip text,
  user_agent text,
  requested_by uuid,
  attested_by uuid,
  attest_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE credit_consents ADD CONSTRAINT credit_consents_status_check CHECK (status IN ('requested','given','revoked'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS credit_consents_application_idx ON credit_consents (application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS credit_pulls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  consent_id uuid NOT NULL REFERENCES credit_consents(id),
  bureau text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL,
  score integer,
  key_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  report_pdf bytea,
  report_document_id text,
  error text,
  pulled_by uuid,
  pulled_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE credit_pulls ADD CONSTRAINT credit_pulls_status_check CHECK (status IN ('completed','no_hit','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS credit_pulls_application_idx ON credit_pulls (application_id, pulled_at DESC);
