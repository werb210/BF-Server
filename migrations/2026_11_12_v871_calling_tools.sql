-- BF_SERVER_v871_CALLING_TOOLS - batch 4 of the BF vs Keystone audit: call scripts and call queues. Ported from KS
-- migrations 2026_11_04_ks_hg1_call_scripts.sql and 2026_11_04_ks_hg1_call_queues.sql without Keystone's plan gates,
-- plus a silo on scripts (BF, BI and SLF each keep their own) and on queues (whose company a queued caller belongs to).
-- Idempotent: safe to run on every start.
--
-- Nothing changes for callers on day 1: there are no queues until an Admin adds one, the main line keeps the phone
-- menu until an Admin picks a main-line queue, and no menu option points at a queue until an Admin chooses one.

-- 1. Call scripts -----------------------------------------------------------------------------------------------------
-- Admins build scripts of sections (talking points and questions with answer fields). Staff open one beside the
-- dialler or on a contact / application; each filled-in script is a run. A finished run goes on the contact's
-- timeline, and answers to questions mapped to a custom field (batch 3) are written to that field.
CREATE TABLE IF NOT EXISTS call_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  name text NOT NULL,
  description text,
  use_for text NOT NULL DEFAULT 'any',
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE call_scripts ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_scripts_use_for_check') THEN
    ALTER TABLE call_scripts ADD CONSTRAINT call_scripts_use_for_check CHECK (use_for IN ('any', 'calls', 'contacts', 'applications'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS call_scripts_silo_name_uidx ON call_scripts (silo, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS call_script_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id uuid NOT NULL REFERENCES call_scripts(id),
  silo text NOT NULL DEFAULT 'BF',
  script_name text NOT NULL,
  script_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  contact_id uuid,
  application_id text,
  call_sid text,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'in_progress',
  field_updates jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE call_script_runs ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_script_runs_status_check') THEN
    ALTER TABLE call_script_runs ADD CONSTRAINT call_script_runs_status_check CHECK (status IN ('in_progress', 'completed'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS call_script_runs_contact_idx ON call_script_runs (contact_id, created_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS call_script_runs_application_idx ON call_script_runs (application_id, created_at DESC) WHERE application_id IS NOT NULL;

-- 2. Call queues ------------------------------------------------------------------------------------------------------
-- Callers to the 866 main line (when an Admin sends it to a queue) or to a phone-menu option that points at a queue
-- wait in a Twilio <Enqueue> queue with hold music, messages and their place in line. Each caller, oldest first, is
-- offered to the member who has been free the longest (available for queue calls, signed in, not on a call, inside
-- their call hours); an unanswered offer goes to the next person. After the queue's longest wait the caller leaves a
-- voicemail or asks for a callback. call_queue_calls is the live list and the history.
CREATE TABLE IF NOT EXISTS call_queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo text NOT NULL DEFAULT 'BF',
  name text NOT NULL,
  greeting text NOT NULL DEFAULT '',
  hold_message text NOT NULL DEFAULT '',
  hold_audio_id text,
  announce_position boolean NOT NULL DEFAULT true,
  max_wait_seconds integer NOT NULL DEFAULT 300,
  ring_seconds integer NOT NULL DEFAULT 20,
  overflow text NOT NULL DEFAULT 'voicemail',
  overflow_user_id uuid,
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE call_queues ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_queues_overflow_check') THEN
    ALTER TABLE call_queues ADD CONSTRAINT call_queues_overflow_check CHECK (overflow IN ('voicemail', 'callback', 'ask'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_queues_wait_check') THEN
    ALTER TABLE call_queues ADD CONSTRAINT call_queues_wait_check CHECK (max_wait_seconds BETWEEN 30 AND 3600);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_queues_ring_check') THEN
    ALTER TABLE call_queues ADD CONSTRAINT call_queues_ring_check CHECK (ring_seconds BETWEEN 10 AND 60);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS call_queues_name_uidx ON call_queues (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS call_queue_members (
  queue_id uuid NOT NULL REFERENCES call_queues(id),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_id, user_id)
);

-- One row per person who takes queue calls: their "available for queue calls" switch and when they were last free.
CREATE TABLE IF NOT EXISTS call_queue_agents (
  user_id uuid PRIMARY KEY,
  available boolean NOT NULL DEFAULT false,
  available_since timestamptz,
  last_call_ended_at timestamptz,
  last_missed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_queue_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id uuid NOT NULL REFERENCES call_queues(id),
  call_sid text NOT NULL,
  from_number text,
  caller_name text,
  contact_id uuid,
  status text NOT NULL DEFAULT 'waiting',
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  twilio_queue_sid text,
  position integer,
  wait_visits integer NOT NULL DEFAULT 0,
  offered_user_id uuid,
  offer_call_sid text,
  offered_at timestamptz,
  offer_attempts integer NOT NULL DEFAULT 0,
  skipped_user_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  answered_user_id uuid,
  answered_at timestamptz,
  ended_at timestamptz,
  wait_seconds integer,
  outcome text,
  callback_done_at timestamptz,
  callback_done_by uuid
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_queue_calls_status_check') THEN
    ALTER TABLE call_queue_calls ADD CONSTRAINT call_queue_calls_status_check
      CHECK (status IN ('waiting', 'offered', 'connected', 'completed', 'abandoned', 'voicemail', 'callback'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS call_queue_calls_sid_uidx ON call_queue_calls (call_sid);
CREATE INDEX IF NOT EXISTS call_queue_calls_live_idx ON call_queue_calls (queue_id, enqueued_at) WHERE status IN ('waiting', 'offered', 'connected');
CREATE INDEX IF NOT EXISTS call_queue_calls_day_idx ON call_queue_calls (enqueued_at);
