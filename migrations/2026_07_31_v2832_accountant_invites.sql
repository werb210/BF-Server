-- BF_SERVER_ACCOUNTANT_INVITE_v1
CREATE TABLE IF NOT EXISTS accountant_invites (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id TEXT NOT NULL,
  contact_id     TEXT NOT NULL,
  email          TEXT NOT NULL,
  sent_at        TIMESTAMPTZ,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, contact_id)
);
