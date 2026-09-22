-- BF_SERVER_ADS_WAREHOUSE_CAMPAIGN_v414
-- The natural key (stat_date, level, name) has no campaign, so a search term
-- running in two campaigns on the same day collapsed to a single row and the
-- upsert overwrote it. Add campaign and widen the key. Existing rows get
-- '(unknown)' - they cannot be attributed retroactively; the next snapshot
-- rewrites the trailing 30 days correctly.
ALTER TABLE google_ads_daily ADD COLUMN IF NOT EXISTS campaign_id   text;
ALTER TABLE google_ads_daily ADD COLUMN IF NOT EXISTS campaign_name text;

UPDATE google_ads_daily SET campaign_name = '(unknown)' WHERE campaign_name IS NULL;
UPDATE google_ads_daily SET campaign_id   = ''          WHERE campaign_id   IS NULL;

DROP INDEX IF EXISTS uq_google_ads_daily;
CREATE UNIQUE INDEX IF NOT EXISTS uq_google_ads_daily_v414
  ON google_ads_daily (stat_date, level, name, COALESCE(campaign_id, ''));
CREATE INDEX IF NOT EXISTS idx_google_ads_daily_campaign
  ON google_ads_daily (level, campaign_id, stat_date DESC);
