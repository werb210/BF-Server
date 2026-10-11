-- BF_SERVER_v786_WORKFLOW_GRAPH - workflow engine v2 (graph workflows), conference room
-- recordings linked to every participant contact, and booking/meeting CRM links.
-- Idempotent: every statement can run again.

-- Workflow graph (schema_version 2). The v1 steps column is kept untouched.
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS graph jsonb;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS settings jsonb;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS schema_version integer DEFAULT 1;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS silo text DEFAULT 'BF';
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS goal jsonb;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS template_key text;
ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS rr_index integer NOT NULL DEFAULT 0;

ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS current_node_id text;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS path jsonb DEFAULT '[]'::jsonb;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS goal_reached_at timestamptz;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS wait_event text;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS wait_timeout_at timestamptz;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS graph jsonb;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS settings jsonb;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS goal jsonb;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS steps_today integer NOT NULL DEFAULT 0;
ALTER TABLE automation_enrollments ADD COLUMN IF NOT EXISTS steps_day date;
ALTER TABLE automation_step_log ADD COLUMN IF NOT EXISTS node_id text;
CREATE INDEX IF NOT EXISTS automation_enrollments_wait_event_idx ON automation_enrollments (contact_id, wait_event) WHERE status = 'active' AND wait_event IS NOT NULL;

-- Daily evaluations (date.relative / no_reply) fire at most once per rule, contact and day.
CREATE TABLE IF NOT EXISTS automation_daily_fires (
  rule_id    uuid NOT NULL,
  contact_id uuid NOT NULL,
  fired_on   date NOT NULL,
  PRIMARY KEY (rule_id, contact_id, fired_on)
);

CREATE TABLE IF NOT EXISTS automation_lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  silo       text NOT NULL DEFAULT 'BF',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_list_members (
  list_id    uuid NOT NULL,
  contact_id uuid NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (list_id, contact_id)
);

-- Conference rooms: the conferences row a room creates on first join, its silo, and
-- every contact a room recording belongs to.
ALTER TABLE conferences ADD COLUMN IF NOT EXISTS meeting_room_id uuid;
CREATE INDEX IF NOT EXISTS conferences_meeting_room_idx ON conferences (meeting_room_id) WHERE meeting_room_id IS NOT NULL;
-- One open conference per room, so two simultaneous first joins cannot create two rows.
CREATE UNIQUE INDEX IF NOT EXISTS conferences_open_room_uq ON conferences (meeting_room_id) WHERE meeting_room_id IS NOT NULL AND ended_at IS NULL;
ALTER TABLE conference_participants ADD COLUMN IF NOT EXISTS contact_id uuid;
ALTER TABLE conference_participants ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';
ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE TABLE IF NOT EXISTS call_recording_contacts (
  recording_id uuid NOT NULL,
  contact_id   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recording_id, contact_id)
);
CREATE INDEX IF NOT EXISTS call_recording_contacts_contact_idx ON call_recording_contacts (contact_id);

-- Bookings: the CRM meeting row and a failure state when Outlook could not be reached.
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS crm_meeting_id uuid;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS failure_reason text;
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS meeting_type text;
ALTER TABLE crm_meetings ADD COLUMN IF NOT EXISTS status text;
