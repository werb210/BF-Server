-- BF_SERVER_v886_OCR_REEXTRACT - one row per one-time data repair that has run on this database.
CREATE TABLE IF NOT EXISTS data_repairs (
  key text PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb
);
