-- BF_SERVER_GRAPH_WEBHOOKS_v1 - store Microsoft Graph mail change-notification subscriptions.
CREATE TABLE IF NOT EXISTS graph_mail_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  subscription_id text NOT NULL,
  resource text NOT NULL,
  client_state text NOT NULL,
  expiration_datetime timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS graph_mail_subscriptions_sub_id_idx ON graph_mail_subscriptions (subscription_id);
CREATE INDEX IF NOT EXISTS graph_mail_subscriptions_user_idx ON graph_mail_subscriptions (user_id);
