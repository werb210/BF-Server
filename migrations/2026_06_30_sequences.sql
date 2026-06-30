-- BF_SERVER_BLOCK_v785_SEQUENCES — multi-step drip sequences across email/sms.
CREATE TABLE IF NOT EXISTS marketing_sequences (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  silo          text NOT NULL DEFAULT 'BF',
  name          text NOT NULL,
  audience_tag  text,
  status        text NOT NULL DEFAULT 'draft',
  stop_on_reply boolean NOT NULL DEFAULT true,
  quiet_start   int NOT NULL DEFAULT 9,
  quiet_end     int NOT NULL DEFAULT 21,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_sequence_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id  uuid NOT NULL,
  step_order   int NOT NULL,
  channel      text NOT NULL,
  wait_minutes int NOT NULL DEFAULT 0,
  condition    text NOT NULL DEFAULT 'always',
  subject      text,
  body         text,
  html         text,
  link_url     text
);
CREATE INDEX IF NOT EXISTS idx_seqstep_seq ON marketing_sequence_steps (sequence_id, step_order);
CREATE TABLE IF NOT EXISTS marketing_sequence_enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id  uuid NOT NULL,
  contact_id   uuid NOT NULL,
  silo         text NOT NULL DEFAULT 'BF',
  current_step int NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'active',
  next_run_at  timestamptz NOT NULL DEFAULT now(),
  enrolled_at  timestamptz NOT NULL DEFAULT now(),
  last_step_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_seqenroll_due ON marketing_sequence_enrollments (status, next_run_at);
