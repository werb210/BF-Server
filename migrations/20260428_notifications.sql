-- BF_NOTIFICATIONS_v50 — idempotent.
CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  type        text NOT NULL,           -- 'mention'
  ref_table   text NOT NULL,           -- 'crm_notes'
  ref_id      text NOT NULL,           -- the note id
  body        text,                    -- short snippet of the note body
  context_url text,                    -- e.g. '/applications/<id>'
  is_read     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notifications_unique_per_ref'
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_unique_per_ref
      UNIQUE (user_id, ref_table, ref_id, type);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, is_read, created_at DESC);
