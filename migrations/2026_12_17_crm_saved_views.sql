-- BF_SERVER_CRM_SAVED_VIEWS_v1 - named, shared filters on a business's people list ("Outreach", "Brokerages", "Call
-- list"...), so one people list per business serves every purpose. Safe to run again.
CREATE TABLE IF NOT EXISTS crm_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL,
  name text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_saved_views_silo_name ON crm_saved_views (silo, lower(name));
