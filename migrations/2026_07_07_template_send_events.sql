-- BF_SERVER_TEMPLATE_ANALYTICS_v1 - per-template send ledger. One row per send that
-- originated from a saved marketing_template. opened_at/clicked_at set async by the
-- SendGrid Event Webhook (via the tse_id custom arg). Replies attributed at query time.
CREATE TABLE IF NOT EXISTS template_send_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id text NOT NULL,
  contact_id  text,
  channel     text NOT NULL,
  silo        text NOT NULL DEFAULT 'BF',
  subject     text,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  opened_at   timestamptz,
  clicked_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_tse_template ON template_send_events (template_id);
CREATE INDEX IF NOT EXISTS idx_tse_contact ON template_send_events (contact_id, sent_at DESC);
