-- BF_SERVER_CUSTOMER_MATCH_LISTS_v711
CREATE TABLE IF NOT EXISTS ads_customer_match_lists (
  kind text PRIMARY KEY,
  list_id text NOT NULL,
  list_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
