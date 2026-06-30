-- BF_SERVER_BLOCK_v787_EMAIL_REPLY_STOP — per-mailbox poll cursor.
CREATE TABLE IF NOT EXISTS mail_poll_state (
  mailbox        text PRIMARY KEY,
  last_polled_at timestamptz NOT NULL DEFAULT now()
);
