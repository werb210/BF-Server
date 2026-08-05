-- BF_SERVER_EMAIL_LINK_CLICKS_v19
-- SendGrid sends the clicked URL on every click event; the webhook was writing
-- only sg_event_id/email/event/ts and discarding it, so "Email link clicked"
-- could never say WHICH link. One row per click, ids as text and no foreign
-- keys so a bad reference can never fail the insert or the migration.
CREATE TABLE IF NOT EXISTS email_link_clicks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  text,
  template_id text,
  tse_id      text,
  silo        text NOT NULL DEFAULT 'BF',
  url         text NOT NULL,
  clicked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_elc_template ON email_link_clicks (template_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_elc_contact ON email_link_clicks (contact_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_elc_clicked_at ON email_link_clicks (clicked_at DESC);
