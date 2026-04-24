DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_direction_enum') THEN
    CREATE TYPE call_direction_enum AS ENUM ('outbound', 'inbound');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_status_enum') THEN
    CREATE TYPE call_status_enum AS ENUM (
      'initiated',
      'ringing',
      'connected',
      'ended',
      'failed'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS call_logs (
  id uuid PRIMARY KEY,
  phone_number text NOT NULL,
  direction call_direction_enum NOT NULL,
  status call_status_enum NOT NULL,
  duration_seconds integer NULL,
  staff_user_id uuid NULL references users(id) on delete set null,
  crm_contact_id uuid NULL,
  application_id uuid NULL references applications(id) on delete set null,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  CONSTRAINT call_logs_duration_check CHECK (duration_seconds IS NULL OR duration_seconds >= 0)
);

CREATE INDEX IF NOT EXISTS call_logs_contact_idx ON call_logs (crm_contact_id);
CREATE INDEX IF NOT EXISTS call_logs_application_idx ON call_logs (application_id);
CREATE INDEX IF NOT EXISTS call_logs_staff_idx ON call_logs (staff_user_id);
