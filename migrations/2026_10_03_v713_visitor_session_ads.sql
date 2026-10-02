-- BF_SERVER_VISITOR_AD_LOOKUP_v713
-- Campaign / ad group / keyword for EVERY ad visit (not only people who applied),
-- and a landing page for every visit.
ALTER TABLE visitor_sessions ADD COLUMN IF NOT EXISTS ad_campaign_name text;
ALTER TABLE visitor_sessions ADD COLUMN IF NOT EXISTS ad_group_name text;
ALTER TABLE visitor_sessions ADD COLUMN IF NOT EXISTS ad_keyword text;
ALTER TABLE visitor_sessions ADD COLUMN IF NOT EXISTS ad_click_date date;
ALTER TABLE visitor_sessions ADD COLUMN IF NOT EXISTS ad_lookup_at timestamptz;
ALTER TABLE visitor_sessions ADD COLUMN IF NOT EXISTS ad_lookup_tries int NOT NULL DEFAULT 0;
-- Visits that arrived without ad or UTM tags never stored a landing page; use the
-- first page they viewed.
UPDATE visitor_sessions s
   SET landing_page = f.path
  FROM (SELECT DISTINCT ON (session_id) session_id, path FROM visitor_events
         WHERE event_type IN ('page_view','pageview') AND COALESCE(path,'') <> ''
         ORDER BY session_id, occurred_at ASC) f
 WHERE f.session_id = s.session_id AND s.landing_page IS NULL;
