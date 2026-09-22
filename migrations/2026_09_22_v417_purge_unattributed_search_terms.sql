-- BF_SERVER_ADS_WAREHOUSE_UPSERT_v417
-- Pre-v414 search-term rows carry campaign_id = '' and cannot be attributed
-- retroactively. Now that the unique key includes campaign_id, a fresh snapshot
-- INSERTS alongside them instead of updating them - so every term would be
-- double counted in the "all campaigns" view and invisible under any real
-- campaign filter. Drop the unattributed search-term rows inside the window the
-- warehouse re-snapshots (trailing 30 days); the next tick refills them with the
-- campaign attached. Campaign and keyword levels are untouched.
DELETE FROM google_ads_daily
 WHERE level = 'search_term'
   AND COALESCE(campaign_id, '') = ''
   AND stat_date >= (CURRENT_DATE - 30);
