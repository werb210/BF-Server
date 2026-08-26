-- BF_SERVER_ABANDON_PERMANENT_FAIL_v119
-- A counter so no send can be retried without limit, whatever the failure mode.
-- The permanent-rejection check below is the real fix; this is the backstop for
-- a failure nobody anticipated - which is exactly what happened here.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS abandon_sms_attempts integer NOT NULL DEFAULT 0;
