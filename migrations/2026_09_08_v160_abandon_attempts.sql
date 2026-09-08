-- BF_SERVER_ABANDON_ATTEMPT_CAP_v1
-- v119 retires a job on a permanent Twilio code and v120 filters structurally
-- undeliverable numbers, but nothing bounds a number that passes both and fails
-- transiently every time. Without a counter it retries on every tick forever --
-- the same unbounded loop that produced 264,397 billed failures, reached by a
-- different route.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS abandon_sms_attempts INTEGER NOT NULL DEFAULT 0;
