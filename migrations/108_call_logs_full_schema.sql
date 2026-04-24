-- 108_call_logs_full_schema.sql
-- Adds the columns that 043_call_logs.sql intended but could never apply
-- because call_logs was created by 104_fix_all_migration_failures without them.
-- Also guards all indexes with IF NOT EXISTS.

ALTER TABLE IF EXISTS call_logs
  ADD COLUMN IF NOT EXISTS staff_user_id   uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS crm_contact_id  uuid NULL,
  ADD COLUMN IF NOT EXISTS application_id  uuid NULL,
  ADD COLUMN IF NOT EXISTS direction       text NULL,
  ADD COLUMN IF NOT EXISTS duration_seconds integer NULL,
  ADD COLUMN IF NOT EXISTS ended_at        timestamptz NULL;

CREATE INDEX IF NOT EXISTS call_logs_staff_idx       ON call_logs (staff_user_id);
CREATE INDEX IF NOT EXISTS call_logs_contact_idx     ON call_logs (crm_contact_id);
CREATE INDEX IF NOT EXISTS call_logs_application_idx ON call_logs (application_id);
