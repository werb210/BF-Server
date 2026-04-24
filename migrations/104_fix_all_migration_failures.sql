ALTER TABLE users
  ALTER COLUMN phone_number DROP NOT NULL;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lenders' AND column_name = 'status'
  ) THEN
    UPDATE lenders
      SET status = (
        CASE
          WHEN status IS NULL THEN 'ACTIVE'
          WHEN LOWER(status::text) = 'inactive' THEN 'INACTIVE'
          ELSE 'ACTIVE'
        END
      )::lender_status
      WHERE status::text NOT IN ('ACTIVE', 'INACTIVE') OR status IS NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS call_logs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  text,
  twilio_call_sid text,
  from_number     text,
  to_number       text,
  direction       text,
  duration        integer,
  status          text,
  recording_sid   text,
  answered        boolean,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS call_logs_twilio_call_sid_unique
  ON call_logs (twilio_call_sid)
  WHERE twilio_call_sid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_call_logs_status         ON call_logs (status);
CREATE INDEX IF NOT EXISTS idx_call_logs_application_id ON call_logs (application_id);

CREATE TABLE IF NOT EXISTS submission_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_id   text,
  event_type  text,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'chat_sessions'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'chat_sessions' AND column_name = 'status'
    ) THEN
      ALTER TABLE chat_sessions ADD COLUMN status text NOT NULL DEFAULT 'active';
    END IF;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'status'
  ) THEN
    UPDATE users SET status = UPPER(status) WHERE status IS NOT NULL;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.constraint_column_usage
      WHERE table_name = 'users' AND constraint_name = 'users_status_check'
    ) THEN
      ALTER TABLE users ADD CONSTRAINT users_status_check
        CHECK (status IN ('ACTIVE', 'INACTIVE'));
    END IF;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'crm_timeline_events_application_id_fkey'
  ) THEN
    ALTER TABLE crm_timeline_events
      DROP CONSTRAINT crm_timeline_events_application_id_fkey;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'communications_messages_application_id_fkey'
  ) THEN
    ALTER TABLE communications_messages
      DROP CONSTRAINT communications_messages_application_id_fkey;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lender_products' AND column_name = 'lender_name'
  ) THEN
    ALTER TABLE lender_products ALTER COLUMN lender_name DROP NOT NULL;
  END IF;
END $$;

-- Seed lender — only the columns that exist in the current schema
INSERT INTO lenders (id, name, country, active, created_at, updated_at)
VALUES ('11111111-1111-1111-1111-111111111111', 'Boreal Direct', 'CA', true, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO lender_products
  (id, lender_id, name, category, active, country, created_at, updated_at)
VALUES
  ('33333333-3333-3333-3333-333333333301','11111111-1111-1111-1111-111111111111','Business Line of Credit','LOC',      true,'CA',now(),now()),
  ('33333333-3333-3333-3333-333333333302','11111111-1111-1111-1111-111111111111','Term Loan',              'TERM',     true,'CA',now(),now()),
  ('33333333-3333-3333-3333-333333333303','11111111-1111-1111-1111-111111111111','Equipment Financing',    'EQUIPMENT',true,'CA',now(),now()),
  ('33333333-3333-3333-3333-333333333304','11111111-1111-1111-1111-111111111111','Working Capital Loan',   'TERM',     true,'CA',now(),now()),
  ('33333333-3333-3333-3333-333333333305','11111111-1111-1111-1111-111111111111','Invoice Factoring',      'FACTORING',true,'CA',now(),now()),
  ('33333333-3333-3333-3333-333333333306','11111111-1111-1111-1111-111111111111','Merchant Cash Advance',  'MCA',      true,'CA',now(),now()),
  ('33333333-3333-3333-3333-333333333307','11111111-1111-1111-1111-111111111111','PO Financing',           'PO',       true,'CA',now(),now())
ON CONFLICT (id) DO NOTHING;
