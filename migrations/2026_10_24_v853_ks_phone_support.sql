-- BF_SERVER_v853_KS_PHONE_SUPPORT - the Keystone (KS) sales / support phone line and the Keystone support ticket queue.
-- 1. companies.ks_support_level: the licensee's support level from KS-Ops (email, priority, premium, dedicated), used
--    for the ticket SLA.
-- 2. ks_phone_queues: one row per Keystone phone queue (sales, support): who rings (ring_user_ids; empty = every
--    staff member with Keystone access), how long it rings, and the opening hours (outside them callers go straight
--    to voicemail).
-- 3. ks_support_tickets + ks_support_ticket_messages: the support queue (number, licensee company, contact, subject,
--    channel, priority, status, assignee, SLA due time) and its thread (customer messages, replies, internal notes,
--    calls, voicemails).
-- Safe to run more than once.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS ks_support_level text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_ks_support_level_check') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_ks_support_level_check
      CHECK (ks_support_level IS NULL OR ks_support_level IN ('email', 'priority', 'premium', 'dedicated'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ks_phone_queues (
  queue                text PRIMARY KEY CHECK (queue IN ('sales', 'support')),
  label                text NOT NULL,
  ring_user_ids        uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ring_timeout_seconds integer NOT NULL DEFAULT 25 CHECK (ring_timeout_seconds BETWEEN 10 AND 60),
  hours_enabled        boolean NOT NULL DEFAULT true,
  timezone             text NOT NULL DEFAULT 'America/Regina',
  weekly               jsonb NOT NULL DEFAULT '{"sun":[],"mon":[["08:00","17:00"]],"tue":[["08:00","17:00"]],"wed":[["08:00","17:00"]],"thu":[["08:00","17:00"]],"fri":[["08:00","17:00"]],"sat":[]}'::jsonb,
  updated_by_user_id   uuid,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ks_phone_queues (queue, label) VALUES ('sales', 'Sales'), ('support', 'Support') ON CONFLICT (queue) DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS ks_support_ticket_number_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS ks_support_tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              bigint NOT NULL DEFAULT nextval('ks_support_ticket_number_seq'),
  company_id          uuid,
  contact_id          uuid,
  subject             text NOT NULL,
  channel             text NOT NULL CHECK (channel IN ('phone', 'email', 'in_app', 'manual')),
  priority            text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status              text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'open', 'waiting', 'resolved', 'closed')),
  assignee_user_id    uuid,
  support_level       text CHECK (support_level IS NULL OR support_level IN ('email', 'priority', 'premium', 'dedicated')),
  sla_due_at          timestamptz,
  first_response_at   timestamptz,
  from_phone          text,
  from_email          text,
  from_name           text,
  external_source     text,
  external_id         text,
  created_by_user_id  uuid,
  last_message_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ks_support_tickets_number_uq ON ks_support_tickets (number);
CREATE UNIQUE INDEX IF NOT EXISTS ks_support_tickets_external_uq ON ks_support_tickets (external_source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ks_support_tickets_status_idx ON ks_support_tickets (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS ks_support_tickets_contact_idx ON ks_support_tickets (contact_id);
CREATE INDEX IF NOT EXISTS ks_support_tickets_company_idx ON ks_support_tickets (company_id);
CREATE INDEX IF NOT EXISTS ks_support_tickets_assignee_idx ON ks_support_tickets (assignee_user_id) WHERE status IN ('new', 'open', 'waiting');

CREATE TABLE IF NOT EXISTS ks_support_ticket_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      uuid NOT NULL REFERENCES ks_support_tickets (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('customer', 'reply', 'note', 'call', 'voicemail', 'system')),
  channel        text,
  body           text NOT NULL DEFAULT '',
  author_user_id uuid,
  author_name    text,
  call_sid       text,
  recording_url  text,
  delivered      boolean,
  delivery_error text,
  external_id    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ks_support_ticket_messages_ticket_idx ON ks_support_ticket_messages (ticket_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ks_support_ticket_messages_call_uq ON ks_support_ticket_messages (ticket_id, kind, call_sid) WHERE call_sid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ks_support_ticket_messages_external_uq ON ks_support_ticket_messages (ticket_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ks_support_ticket_messages_call_idx ON ks_support_ticket_messages (call_sid) WHERE call_sid IS NOT NULL;
