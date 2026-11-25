-- BF_SERVER_CRM_FLOWS_v1 (2026-11-24) - email flows for the Boreal Financial and Keystone CRMs, the same rules as
-- Boreal Risk Management's flows (BI-Server): everyone gets a first email, and what each person does next (nothing,
-- opened, clicked) picks the next one. Flows are the one way to email a list. Idempotent.
CREATE TABLE IF NOT EXISTS crm_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  name text NOT NULL,
  audience_tags text[] NOT NULL DEFAULT '{}'::text[],
  market text NOT NULL DEFAULT 'ALL',
  status text NOT NULL DEFAULT 'draft',
  daily_new integer NOT NULL DEFAULT 100,
  from_name text,
  from_email text,
  reply_to text,
  owner_user_id uuid,
  owner_name text,
  link_url text,
  booking_url text,
  emails jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_flows_status_check CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  CONSTRAINT crm_flows_market_check CHECK (market IN ('US', 'CA', 'ALL'))
);
CREATE INDEX IF NOT EXISTS crm_flows_silo_idx ON crm_flows (silo, status);
CREATE TABLE IF NOT EXISTS crm_flow_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES crm_flows(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  track text NOT NULL DEFAULT 'none',
  sent_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_sent_at timestamptz,
  first_sent_at timestamptz,
  next_key text,
  next_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  task_created_at timestamptz,
  events_seen_at timestamptz NOT NULL DEFAULT now(),
  stop_reason text,
  failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_flow_members_status_check CHECK (status IN ('queued', 'active', 'done', 'stopped')),
  CONSTRAINT crm_flow_members_track_check CHECK (track IN ('none', 'opened', 'clicked'))
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_flow_members_flow_contact_uq ON crm_flow_members (flow_id, contact_id);
CREATE INDEX IF NOT EXISTS crm_flow_members_due_idx ON crm_flow_members (next_at) WHERE status = 'active' AND next_key IS NOT NULL;
-- Opens and clicks from the SendGrid event webhook for flow emails (job id crmflow:<flow>:<key>).
CREATE TABLE IF NOT EXISTS crm_flow_events (
  id bigserial PRIMARY KEY,
  flow_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  email_key text NOT NULL,
  event_type text NOT NULL,
  url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_flow_events_contact_idx ON crm_flow_events (flow_id, contact_id, created_at);
