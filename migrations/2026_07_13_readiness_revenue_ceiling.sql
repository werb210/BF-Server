-- BF_SERVER_READINESS_CEILING_v1
-- The revenue basis was the FLOOR of the declared band, inherited from the website's
-- scoring function. That is wrong and it produced false positives: Bob Belcher asking
-- $200,000 against "$150,001 to $500,000" was graded against $150,001 (1.3x = flagged as
-- over-asking) when he is really asking at most 40% of revenue - a perfectly normal ask.
--
-- Operator decision: grade against the TOP of the declared band. Someone who says
-- "$1,000,001 to $3,000,000" is assessed against $3,000,000.
--
-- "Over $3,000,000" is unbounded, so $3,000,000 is used as its basis. That is deliberately
-- conservative: it can only ever over-flag an ask, never under-flag one.
--
-- Both the over-ask check AND the request-ratio component of the score use this basis, so
-- the badge and the number can never disagree with each other.
CREATE OR REPLACE FUNCTION bf_readiness_revenue_basis(p_annual_revenue_range text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $FN$
  SELECT CASE
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%over $3,000,000%' THEN 3000000
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$1,000,001 to $3,000,000%' THEN 3000000
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$500,001 to $1,000,000%' THEN 1000000
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$150,001 to $500,000%' THEN 500000
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%zero to $150,000%' THEN 150000
    ELSE 150000
  END::numeric;
$FN$;

-- Rebuilt to use the ceiling basis in its request-ratio component (max 10 pts).
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
        WHEN p_requested / bf_readiness_revenue_basis(p_annual_revenue_range) < 0.1 THEN 10
        WHEN p_requested / bf_readiness_revenue_basis(p_annual_revenue_range) < 0.3 THEN 8
        WHEN p_requested / bf_readiness_revenue_basis(p_annual_revenue_range) < 0.6 THEN 4
        WHEN p_requested / bf_readiness_revenue_basis(p_annual_revenue_range) < 1.0 THEN 1
        ELSE 0
      END AS req
  )
  SELECT GREATEST(0, LEAST(100, s.yrs + s.rev + s.coll + s.ar + s.req)) FROM s;
$FN$;

CREATE OR REPLACE FUNCTION bf_readiness_over_ask(
  p_annual_revenue_range text,
  p_requested numeric
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $FN$
  SELECT CASE
    WHEN p_requested IS NULL OR p_requested <= 0 THEN false
    ELSE p_requested >= bf_readiness_revenue_basis(p_annual_revenue_range)
  END;
$FN$;

-- Re-grade every row against the ceiling basis.
UPDATE readiness_sessions
   SET readiness_score = bf_readiness_score(
         sales_history_years, annual_revenue_range, fixed_assets_value_range,
         accounts_receivable_range, requested_amount),
       readiness_over_ask = bf_readiness_over_ask(annual_revenue_range, requested_amount),
       readiness_tier = bf_readiness_tier(
         bf_readiness_score(
           sales_history_years, annual_revenue_range, fixed_assets_value_range,
           accounts_receivable_range, requested_amount),
         bf_readiness_over_ask(annual_revenue_range, requested_amount)),
       updated_at = now();

-- The floor-based helper is now dead and must not be callable by accident.
DROP FUNCTION IF EXISTS bf_readiness_revenue_floor(text);
