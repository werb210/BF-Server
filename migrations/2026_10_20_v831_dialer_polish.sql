-- BF_SERVER_v831_DIALER_POLISH - changes the iPhone dialler saved with no signal (call outcomes, tasks, call logs, texts)
-- carry an Idempotency-Key. A request that already went through answers with its first result instead of running twice
-- (middleware/replayKey.ts), so a resend after a dropped reply cannot duplicate a task, note or text.
CREATE TABLE IF NOT EXISTS dialer_request_keys (
  user_id text NOT NULL,
  key text NOT NULL,
  scope text NOT NULL,
  status_code integer,
  body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS dialer_request_keys_created_idx ON dialer_request_keys (created_at);
