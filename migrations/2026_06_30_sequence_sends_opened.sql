-- BF_SERVER_BLOCK_v790 — track email opens on sequence sends.
ALTER TABLE IF EXISTS sequence_sends ADD COLUMN IF NOT EXISTS opened_at timestamptz;
