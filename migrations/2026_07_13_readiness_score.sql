-- BF_SERVER_READINESS_SCORE_v1
-- The credit-readiness outcome was computed in the BROWSER (bf-website
-- src/lib/creditReadinessScore.ts), shown to the prospect on /credit-results, saved to
-- localStorage - and then thrown away. It was never posted to the server and there was
-- no column to hold it, so staff could never see the result of a form the prospect had
-- already filled in.
--
-- The score is now computed SERVER-SIDE from the answers we already store, which means
-- (a) every existing row can be backfilled, (b) a prospect cannot tamper with their own
-- score, and (c) the website needs no change.
--
-- Asserts every column it touches: the migration ledger is keyed on FILENAME, so an
-- earlier file's ADD COLUMN lines may never have run against this database. Note the
-- live table has NO `score` column despite migration 090b declaring one - exactly the
-- drift this guards against.
ALTER TABLE readiness_sessions
  ADD COLUMN IF NOT EXISTS readiness_score integer,
  ADD COLUMN IF NOT EXISTS readiness_tier text;

-- Mirrors scoreCreditReadiness() in bf-website exactly. Kept as SQL so the backfill and
-- the live write cannot drift from each other.
CREATE OR REPLACE FUNCTION bf_readiness_score(
  p_years text,
  p_annual_revenue_range text,
  p_fixed_assets text,
  p_ar text,
  p_requested numeric
) RETURNS integer LANGUAGE sql IMMUTABLE AS $FN$
  WITH s AS (
    SELECT
      CASE
        WHEN lower(coalesce(p_years,'')) LIKE '%over 3%' OR lower(coalesce(p_years,'')) LIKE '%5+%' OR lower(coalesce(p_years,'')) LIKE '%3-5%' THEN 25
        WHEN lower(coalesce(p_years,'')) LIKE '%1 to 3%' OR lower(coalesce(p_years,'')) LIKE '%2-3%' THEN 15
        WHEN lower(coalesce(p_years,'')) LIKE '%under 1%' OR lower(coalesce(p_years,'')) LIKE '%<1%' THEN 5
        ELSE 0
      END AS yrs,
      CASE
        WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%over $3,000,000%' OR lower(coalesce(p_annual_revenue_range,'')) LIKE '%5m+%' THEN 30
        WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$1,000,001 to $3,000,000%' OR lower(coalesce(p_annual_revenue_range,'')) LIKE '%1m-5m%' THEN 24
        WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$500,001 to $1,000,000%' OR lower(coalesce(p_annual_revenue_range,'')) LIKE '%500k-1m%' THEN 18
        WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$150,001 to $500,000%' OR lower(coalesce(p_annual_revenue_range,'')) LIKE '%100k-500k%' THEN 10
        WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%zero to $150,000%' OR lower(coalesce(p_annual_revenue_range,'')) LIKE '%<100k%' THEN 4
        ELSE 0
      END AS rev,
      CASE
        WHEN lower(coalesce(p_fixed_assets,'')) LIKE '%over $500,000%' OR lower(coalesce(p_fixed_assets,'')) LIKE '%1m+%' THEN 20
        WHEN lower(coalesce(p_fixed_assets,'')) LIKE '%$250,001 to $500,000%' OR lower(coalesce(p_fixed_assets,'')) LIKE '%500k%' THEN 14
        WHEN lower(coalesce(p_fixed_assets,'')) LIKE '%$100,001 to $250,000%' OR lower(coalesce(p_fixed_assets,'')) LIKE '%100k%' THEN 8
        WHEN lower(coalesce(p_fixed_assets,'')) LIKE '%$1 to $50,000%' OR lower(coalesce(p_fixed_assets,'')) LIKE '%$50,001 to $100,000%' OR lower(coalesce(p_fixed_assets,'')) LIKE '%<100k%' THEN 3
        ELSE 0
      END AS coll,
      CASE
        WHEN lower(coalesce(p_ar,'')) LIKE '%over $3,000,000%' OR lower(coalesce(p_ar,'')) LIKE '%$1,000,000 to $3,000,000%' OR lower(coalesce(p_ar,'')) LIKE '%500k+%' THEN 15
        WHEN lower(coalesce(p_ar,'')) LIKE '%$250,000 to $500,000%' OR lower(coalesce(p_ar,'')) LIKE '%$100,000 to $250,000%' OR lower(coalesce(p_ar,'')) LIKE '%100k-500k%' THEN 10
        WHEN lower(coalesce(p_ar,'')) LIKE '%zero to $100,000%' OR lower(coalesce(p_ar,'')) LIKE '%<100k%' THEN 4
        ELSE 0
      END AS ar,
      CASE
        WHEN p_requested IS NULL OR p_requested <= 0 THEN 5
        ELSE (
          SELECT CASE
            WHEN p_requested / floor_rev < 0.1 THEN 10
            WHEN p_requested / floor_rev < 0.3 THEN 8
            WHEN p_requested / floor_rev < 0.6 THEN 4
            WHEN p_requested / floor_rev < 1.0 THEN 1
            ELSE 0
          END
          FROM (SELECT CASE
            WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%over $3,000,000%' THEN 3000000
            WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$1,000,001 to $3,000,000%' THEN 1000000
            WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$500,001 to $1,000,000%' THEN 500000
            WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$150,001 to $500,000%' THEN 150000
            ELSE 75000 END::numeric AS floor_rev) f
        )
      END AS req
  )
  SELECT GREATEST(0, LEAST(100, s.yrs + s.rev + s.coll + s.ar + s.req)) FROM s;
$FN$;

-- green >= 50, yellow 30-49, red < 30 (BF_WEBSITE_READINESS_TIERS_v2, re-banded 2026-07-04)
CREATE OR REPLACE FUNCTION bf_readiness_tier(p_score integer)
RETURNS text LANGUAGE sql IMMUTABLE AS $FN$
  SELECT CASE WHEN p_score >= 50 THEN 'green' WHEN p_score >= 30 THEN 'yellow' ELSE 'red' END;
$FN$;

-- Backfill every existing row, including the ones already in production.
UPDATE readiness_sessions
   SET readiness_score = bf_readiness_score(
         sales_history_years, annual_revenue_range, fixed_assets_value_range,
         accounts_receivable_range, requested_amount),
       readiness_tier = bf_readiness_tier(bf_readiness_score(
         sales_history_years, annual_revenue_range, fixed_assets_value_range,
         accounts_receivable_range, requested_amount)),
       updated_at = now()
 WHERE readiness_score IS NULL;
