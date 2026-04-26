-- Maya AI agent escalation log. Populated by the agent service via
-- POST /api/maya/escalations whenever a user clicks "Talk to Human" or
-- Maya's confidence drops below threshold.
CREATE TABLE IF NOT EXISTS maya_escalations (
  id              uuid PRIMARY KEY,  -- generated app-side via randomUUID() for Azure pg compat
  session_id      text,
  application_id  uuid,
  reason          text NOT NULL,
  surface         text,
  silo            text,
  payload         jsonb DEFAULT '{}'::jsonb,
  notified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maya_escalations_session_recent
  ON maya_escalations (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_maya_escalations_created
  ON maya_escalations (created_at DESC);
