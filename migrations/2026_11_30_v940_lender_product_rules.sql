-- BF_SERVER_v940_LENDER_PRODUCT_RULES (Todd, Nov 11 2026)
-- match_rules: knock-outs a lender sets on a product. A file that breaks one is not shown to that lender.
--   { max_nsf_per_month, min_monthly_revenue, max_funding_multiple, min_avg_daily_balance, max_positions, min_months_in_business }
--   max_funding_multiple: the lender funds up to N x the average monthly revenue (e.g. 1.5 -> $10,000/month funds up to $15,000).
-- commission_terms: how the lender pays the brokerage on a funded deal (defaults for the Close tab).
--   { kind: 'flat' | 'percent' | 'profit_share', amount, percent, share_percent, share_months, clawback_days }
ALTER TABLE lender_products ADD COLUMN IF NOT EXISTS match_rules jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE lender_products ADD COLUMN IF NOT EXISTS commission_terms jsonb NOT NULL DEFAULT '{}'::jsonb;
