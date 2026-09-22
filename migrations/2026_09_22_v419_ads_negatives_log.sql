-- BF_SERVER_NEGATIVES_SAFETY_v419
-- Adding a negative was one click and undoing it meant hunting through the
-- Google Ads UI. Keep Google's resourceName so the portal can remove it again.
CREATE TABLE IF NOT EXISTS ads_negatives_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   text NOT NULL,
  campaign_name text,
  term          text NOT NULL,
  match_type    text NOT NULL,
  resource_name text,
  added_by      text,
  added_at      timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ads_negatives_log_active
  ON ads_negatives_log (added_at DESC) WHERE removed_at IS NULL;
