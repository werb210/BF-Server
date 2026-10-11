-- BF_SERVER_MAYA_SMS_CONFIRM_v1
-- Maya never sends an SMS on her own. POST /api/maya/staff/send-sms (called by
-- the agent) only records a pending action here; a signed-in staff member
-- presses Send in the portal's Maya panel (POST /api/maya/pending-actions/:id/confirm),
-- and only that human click sends the text.
CREATE TABLE IF NOT EXISTS maya_pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  staff_user_id text NULL,
  silo text NULL,
  status text NOT NULL DEFAULT 'pending', -- pending | sent | cancelled | expired | failed
  result jsonb NULL,
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes')
);

CREATE INDEX IF NOT EXISTS idx_maya_pending_actions_staff_status
  ON maya_pending_actions (staff_user_id, status, expires_at);
