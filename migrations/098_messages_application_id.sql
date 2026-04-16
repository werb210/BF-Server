ALTER TABLE communications_messages
  ADD COLUMN IF NOT EXISTS application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS staff_name text;

CREATE INDEX IF NOT EXISTS idx_comm_messages_application_id
  ON communications_messages(application_id);
