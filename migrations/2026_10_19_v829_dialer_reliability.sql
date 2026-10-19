-- BF_SERVER_v829_DIALER_RELIABILITY
-- 1. call_logs.answered_leg_sid: the CallSid of the staff leg that answered an inbound call (the sid the iPhone dialler
--    holds). The row itself keeps the caller's (parent) CallSid.
-- 2. dialer_client_events: what the iPhone dialler reports about its own calls (answer tapped, audio ready, connected,
--    failures), so a slow or failed call can be diagnosed afterwards.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS answered_leg_sid text;
CREATE INDEX IF NOT EXISTS idx_call_logs_answered_leg_sid ON call_logs (answered_leg_sid) WHERE answered_leg_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_logs_twilio_call_sid ON call_logs (twilio_call_sid) WHERE twilio_call_sid IS NOT NULL;

CREATE TABLE IF NOT EXISTS dialer_client_events (
  id bigserial PRIMARY KEY,
  user_id uuid,
  app_version text,
  event text NOT NULL,
  call_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dialer_client_events_user_time ON dialer_client_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_dialer_client_events_call_ref ON dialer_client_events (call_ref) WHERE call_ref IS NOT NULL;
