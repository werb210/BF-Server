-- BF_SERVER_v869_SETTINGS_PACK - Settings pack ported from KS-server #38 (KS migrations 2026_11_02_ks_sp1 to sp10,
-- without sp6 "brokerage time zone": Boreal is fixed to Alberta time, UTC-6 all year). Idempotent: safe to run again.
-- Silo notes: privacy requests and lead-rotation assignments carry a silo; the phone menu is one menu for the 866 main
-- line (it answers for every Boreal company); never-log, blocked numbers and the security switch apply to everyone.

-- Phone menu (src/phoneMenu). No row = Boreal's live menu (defaultBorealMenu), so nothing changes on day 1.
CREATE TABLE IF NOT EXISTS phone_menu_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
CREATE TABLE IF NOT EXISTS phone_menu_audio (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  bytes bytea NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Company-wide switches set by an Admin (one JSON value per key: booking, security, blocked_numbers, nps,
-- lead_rotation:BF / lead_rotation:BI / lead_rotation:SLF). See src/settingsPack/common.ts.
CREATE TABLE IF NOT EXISTS boreal_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);


CREATE TABLE IF NOT EXISTS booking_meeting_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  duration_min integer NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 10 AND 240),
  kind text NOT NULL DEFAULT 'phone' CHECK (kind IN ('phone', 'video')),
  buffer_min integer NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 120),
  min_notice_min integer NOT NULL DEFAULT 120 CHECK (min_notice_min BETWEEN 0 AND 20160),
  max_days_ahead integer NOT NULL DEFAULT 14 CHECK (max_days_ahead BETWEEN 1 AND 90),
  active boolean NOT NULL DEFAULT true,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_meeting_types_slug_idx ON booking_meeting_types (slug);

ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS meeting_type_id uuid;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS manage_token_hash text;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS sms_reminders boolean NOT NULL DEFAULT false;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS reminder_24h_at timestamptz;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS reminder_1h_at timestamptz;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE client_bookings ADD COLUMN IF NOT EXISTS rescheduled_to uuid;
CREATE UNIQUE INDEX IF NOT EXISTS client_bookings_manage_token_idx ON client_bookings (manage_token_hash) WHERE manage_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_bookings_reminders_idx ON client_bookings (starts_at) WHERE status = 'booked';

-- Cookie consent choices and privacy requests (access, correction, deletion).

CREATE TABLE IF NOT EXISTS cookie_consents (
  id bigserial PRIMARY KEY,
  visitor_id text NOT NULL,
  surface text NOT NULL,
  choice text NOT NULL CHECK (choice IN ('granted', 'denied')),
  categories jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version text,
  ip_hash text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cookie_consents_visitor_idx ON cookie_consents (visitor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid,
  contact_label text,
  kind text NOT NULL CHECK (kind IN ('access', 'correction', 'deletion')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'refused')),
  details text,
  received_via text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  outcome jsonb,
  completed_at timestamptz,
  completed_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS privacy_requests_open_idx ON privacy_requests (status, due_at);

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('otp', 'passkey', 'sso', 'device')),
  strong boolean NOT NULL DEFAULT false,
  ip text,
  user_agent text,
  device_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid
);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id, last_seen_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS never_log_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  value text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('email', 'domain')),
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_rotation_assignments (
  id bigserial PRIMARY KEY,
  contact_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_rotation_assignments_user_idx ON lead_rotation_assignments (user_id, assigned_at DESC);

-- Blocked callers and texters; what a blocked call hears is in boreal_settings ('blocked_numbers').
CREATE TABLE IF NOT EXISTS blocked_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS blocked_number_events (
  id bigserial PRIMARY KEY,
  number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('call', 'text')),
  action text NOT NULL,
  body text,
  twilio_sid text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blocked_number_events_at_idx ON blocked_number_events (created_at DESC);

CREATE TABLE IF NOT EXISTS nps_surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL UNIQUE,
  contact_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'responded', 'skipped', 'failed')),
  due_at timestamptz NOT NULL,
  token_hash text,
  channels text[] NOT NULL DEFAULT '{}',
  sent_at timestamptz,
  skip_reason text,
  score integer CHECK (score BETWEEN 0 AND 10),
  comment text,
  responded_at timestamptz,
  review_link_shown boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nps_surveys_due_idx ON nps_surveys (status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS nps_surveys_token_idx ON nps_surveys (token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_task_defaults (
  user_id uuid PRIMARY KEY,
  prompt_after_call boolean NOT NULL DEFAULT true,
  prompt_after_email boolean NOT NULL DEFAULT true,
  prompt_after_meeting boolean NOT NULL DEFAULT true,
  due_in_days integer NOT NULL DEFAULT 1 CHECK (due_in_days BETWEEN 0 AND 60),
  due_time text NOT NULL DEFAULT '09:00',
  task_type text NOT NULL DEFAULT 'CALL' CHECK (task_type IN ('CALL', 'EMAIL', 'SMS', 'TODO')),
  reminder_minutes integer CHECK (reminder_minutes IS NULL OR reminder_minutes BETWEEN 0 AND 10080),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- BF_SERVER_v869_SETTINGS_PACK - Boreal additions.
ALTER TABLE privacy_requests ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';
ALTER TABLE privacy_requests ADD COLUMN IF NOT EXISTS requester_email text;
ALTER TABLE privacy_requests ADD COLUMN IF NOT EXISTS requester_phone text;
CREATE INDEX IF NOT EXISTS privacy_requests_silo_idx ON privacy_requests (silo, status, due_at);
ALTER TABLE lead_rotation_assignments ADD COLUMN IF NOT EXISTS silo text NOT NULL DEFAULT 'BF';
CREATE INDEX IF NOT EXISTS lead_rotation_assignments_silo_idx ON lead_rotation_assignments (silo, user_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS staff_refresh_tokens_ksid_idx ON staff_refresh_tokens (ksid) WHERE ksid IS NOT NULL;
