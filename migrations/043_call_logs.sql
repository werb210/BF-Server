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
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  CONSTRAINT call_logs_duration_check CHECK (duration_seconds IS NULL OR duration_seconds >= 0)
);

-- BF_SERVER_MIGRATION_043_APP_ID_TYPE_v1
DO $call_logs_app_id$
DECLARE app_id_type text;
BEGIN
  SELECT atttypid::regtype::text INTO app_id_type FROM pg_attribute
    WHERE attrelid = 'public.applications'::regclass AND attname = 'id' AND NOT attisdropped;
  IF app_id_type IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'call_logs' AND column_name = 'application_id') THEN
    EXECUTE format('ALTER TABLE call_logs ADD COLUMN application_id %s NULL', app_id_type);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.call_logs'::regclass
      AND confrelid = 'public.applications'::regclass AND contype = 'f') THEN
    ALTER TABLE call_logs ADD CONSTRAINT call_logs_application_id_fkey
      FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE SET NULL;
  END IF;
END
$call_logs_app_id$;

CREATE INDEX IF NOT EXISTS call_logs_contact_idx ON call_logs (crm_contact_id);
CREATE INDEX IF NOT EXISTS call_logs_application_idx ON call_logs (application_id);
CREATE INDEX IF NOT EXISTS call_logs_staff_idx ON call_logs (staff_user_id);
