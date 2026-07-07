-- BF_SERVER_AD_ATTRIBUTION_v1
-- Stores the Google Ads click attribution resolved from a contact gclid.
CREATE TABLE IF NOT EXISTS contact_ad_attribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  gclid text NOT NULL,
  click_date date,
  campaign_id text,
  campaign_name text,
  ad_group_id text,
  ad_group_name text,
  ad_id text,
  keyword text,
  keyword_match_type text,
  raw_click jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, gclid)
);

CREATE INDEX IF NOT EXISTS idx_contact_ad_attribution_contact_id
  ON contact_ad_attribution(contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_ad_attribution_gclid
  ON contact_ad_attribution(gclid);
