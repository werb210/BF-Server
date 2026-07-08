-- BF_SERVER_ADS_WAREHOUSE_v1 - own your Google Ads history. One row per (date, level,
-- name). Snapshotted daily from the Google Ads API so metrics survive cache wipes,
-- deploys, and Google's own retention windows. Idempotent upsert on the natural key.
CREATE TABLE IF NOT EXISTS google_ads_daily (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stat_date     date NOT NULL,
  level         text NOT NULL,
  name          text NOT NULL,
  status        text,
  cost          numeric(14,2) NOT NULL DEFAULT 0,
  impressions   bigint NOT NULL DEFAULT 0,
  clicks        bigint NOT NULL DEFAULT 0,
  conversions   numeric(14,2) NOT NULL DEFAULT 0,
  conv_value    numeric(14,2) NOT NULL DEFAULT 0,
  synced_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_google_ads_daily ON google_ads_daily (stat_date, level, name);
CREATE INDEX IF NOT EXISTS idx_google_ads_daily_date ON google_ads_daily (stat_date DESC);
