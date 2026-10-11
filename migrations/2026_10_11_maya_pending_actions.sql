-- BF_SERVER_v784_MAYA_SMS_CONFIRM
-- Actions Maya proposes for staff (today: outbound SMS) wait here until the
-- staff member confirms them in the portal. Maya never sends on its own.
CREATE TABLE IF NOT EXISTS maya_pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  staff_user_id text NULL,
  silo text NULL,
  status text NOT NULL DEFAULT 'pending',
  result jsonb NULL,
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes'
);

CREATE INDEX IF NOT EXISTS maya_pending_actions_staff_status_idx
  ON maya_pending_actions (staff_user_id, status);
