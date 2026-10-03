-- BF_SERVER_WEEKLY_SUMMARY_v721 - one Monday summary per week.
CREATE TABLE IF NOT EXISTS weekly_summary_reports (
  week_start date PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipients text
);
