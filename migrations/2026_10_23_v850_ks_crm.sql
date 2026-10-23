-- BF_SERVER_v850_KS_CRM - Keystone (KS) becomes a fourth CRM silo.
-- 1. The tasks tables accept silo 'KS' (their CHECKs listed BF/BI/SLF only).
-- 2. The Keystone sales pipeline stage lives on the contact and on the company (ks_stage), like lifecycle_stage but
--    with Keystone's own stage keys: lead, demo_started, demo_finished, signed_up, paying, lost.
-- 3. Keystone company details KS-Ops sends: company code, plan, seats, status.
-- 4. ks_crm_refs maps a KS-Ops record (source + external_id) to the contact/company it created, so later updates
--    hit the same records even if the email changes, and keeps the demo progress the pipeline cards show.
-- 5. ks_crm_timeline_keys makes timeline notes/events from KS-Ops idempotent.
-- Safe to run more than once.

ALTER TABLE IF EXISTS tasks DROP CONSTRAINT IF EXISTS tasks_silo_check;
ALTER TABLE IF EXISTS tasks ADD CONSTRAINT tasks_silo_check CHECK (silo IN ('BF', 'BI', 'SLF', 'KS'));
ALTER TABLE IF EXISTS task_queues DROP CONSTRAINT IF EXISTS task_queues_silo_check;
ALTER TABLE IF EXISTS task_queues ADD CONSTRAINT task_queues_silo_check CHECK (silo IN ('BF', 'BI', 'SLF', 'KS'));
ALTER TABLE IF EXISTS task_queue_shares DROP CONSTRAINT IF EXISTS task_queue_shares_silo_check;
ALTER TABLE IF EXISTS task_queue_shares ADD CONSTRAINT task_queue_shares_silo_check CHECK (silo IN ('BF', 'BI', 'SLF', 'KS'));

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ks_stage text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ks_stage_changed_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ks_stage text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ks_stage_changed_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ks_company_code text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ks_plan text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ks_seats integer;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ks_status text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_ks_stage_check') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_ks_stage_check
      CHECK (ks_stage IS NULL OR ks_stage IN ('lead', 'demo_started', 'demo_finished', 'signed_up', 'paying', 'lost'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_ks_stage_check') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_ks_stage_check
      CHECK (ks_stage IS NULL OR ks_stage IN ('lead', 'demo_started', 'demo_finished', 'signed_up', 'paying', 'lost'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS contacts_ks_stage_idx ON contacts (ks_stage) WHERE silo = 'KS';
CREATE INDEX IF NOT EXISTS companies_ks_stage_idx ON companies (ks_stage) WHERE silo = 'KS';
CREATE INDEX IF NOT EXISTS companies_ks_code_idx ON companies (lower(ks_company_code)) WHERE silo = 'KS' AND ks_company_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS ks_crm_refs (
  source            text NOT NULL CHECK (source IN ('demo_signup', 'website_signup', 'licensee')),
  external_id       text NOT NULL,
  contact_id        uuid,
  company_id        uuid,
  demo_opened_at    timestamptz,
  demo_steps        integer NOT NULL DEFAULT 0,
  demo_completed_at timestamptz,
  last_event_type   text,
  last_event_at     timestamptz,
  last_event_summary text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, external_id)
);
CREATE INDEX IF NOT EXISTS ks_crm_refs_contact_idx ON ks_crm_refs (contact_id);
CREATE INDEX IF NOT EXISTS ks_crm_refs_company_idx ON ks_crm_refs (company_id);

CREATE TABLE IF NOT EXISTS ks_crm_timeline_keys (
  dedupe_key  text PRIMARY KEY,
  crm_note_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
