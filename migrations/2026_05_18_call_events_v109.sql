-- Block 109 (revived for live migration dir)
CREATE TABLE IF NOT EXISTS call_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  contact_id UUID,
  application_id UUID,
  silo TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('call.started','call.ended','call.failed','call.missed','call.declined')),
  direction TEXT CHECK (direction IN ('outbound','inbound')),
  from_number TEXT,
  to_number TEXT,
  twilio_call_sid TEXT,
  duration_seconds INT,
  error_code TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_events_user ON call_events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_events_contact ON call_events(contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_events_application ON call_events(application_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_events_sid ON call_events(twilio_call_sid);

ALTER TABLE users ADD COLUMN IF NOT EXISTS outbound_caller_id TEXT;
