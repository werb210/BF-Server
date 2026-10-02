-- BF_SERVER_ADS_AUDIENCES_v708
-- Which contact has been sent to which Google Customer Match list, so each
-- person is uploaded once; and which weekly ads emails have gone out.
CREATE TABLE IF NOT EXISTS ads_audience_members (
  list_id text NOT NULL,
  contact_id text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, contact_id)
);
CREATE TABLE IF NOT EXISTS ads_weekly_reports (
  week_start date PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipients text
);
