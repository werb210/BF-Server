-- BF_SERVER_ENGAGEMENT_v1 (2026-11-27) - Keystone (and any BF-Server CRM) marketing follow-through, the same as
-- BI-Server's bi_engagement for PGI: one row per contact the email flows reached, the stage they have got to, the reply
-- and its kind, the owner and when the follow-up is due. Idempotent.
CREATE TABLE IF NOT EXISTS crm_engagement (
  contact_id uuid PRIMARY KEY,
  silo text NOT NULL,
  flow_id uuid,
  stage text NOT NULL DEFAULT 'sent',
  stage_at timestamptz,
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  replied_at timestamptz,
  booked_at timestamptz,
  met_at timestamptz,
  signed_up_at timestamptz,
  lost_at timestamptz,
  lost_reason text,
  reply_kind text,
  reply_subject text,
  reply_snippet text,
  reply_mailbox text,
  meeting_at timestamptz,
  meeting_outcome text,
  owner_user_id text,
  owner_name text,
  follow_up_due_at timestamptz,
  follow_up_reason text,
  followed_up_at timestamptz,
  task_for timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_engagement_silo_stage_idx ON crm_engagement (silo, stage);
CREATE INDEX IF NOT EXISTS crm_engagement_due_idx ON crm_engagement (follow_up_due_at) WHERE follow_up_due_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS crm_engagement_events (
  id bigserial PRIMARY KEY,
  contact_id uuid NOT NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_name text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_engagement_events_contact_idx ON crm_engagement_events (contact_id, at DESC);
CREATE TABLE IF NOT EXISTS crm_engagement_settings (
  silo text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (silo, key)
);
-- Inbound messages the reply catcher has already handled (Graph message ids), so a reply is filed once.
CREATE TABLE IF NOT EXISTS crm_reply_catch_seen (
  message_id text PRIMARY KEY,
  seen_at timestamptz NOT NULL DEFAULT now()
);
