-- BF_SERVER_READINESS_OVER_ASK_v1
-- The ported scoring model rates the request-to-revenue ratio at only 10 points out of
-- 100, so a borrower asking 20x their revenue still scored 84/100 "Strong" (John Gakinya
-- Waiharo: $20,000,000 requested against $1,000,001-$3,000,000 revenue). The badge would
-- have told staff their least fundable lead was their strongest.
--
-- Operator decision: an ask at or above 1.0x the revenue floor can never be green.
-- Most credit products cap out well below that (commonly ~35% of revenue), so a request
-- at or beyond 1x revenue is not a "Strong" file no matter how good the other inputs are.
-- The numeric score is left untouched - it still reflects the underlying business - but
-- the TIER is capped, and the over-ask is recorded so the portal can show it explicitly.
ALTER TABLE readiness_sessions
  ADD COLUMN IF NOT EXISTS readiness_over_ask boolean;

-- Revenue floor of the band, matching bf_readiness_score()'s requestScore().
CREATE OR REPLACE FUNCTION bf_readiness_revenue_floor(p_annual_revenue_range text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $FN$
  SELECT CASE
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%over $3,000,000%' THEN 3000000
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$1,000,001 to $3,000,000%' THEN 1000000
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$500,001 to $1,000,000%' THEN 500000
    WHEN lower(coalesce(p_annual_revenue_range,'')) LIKE '%$150,001 to $500,000%' THEN 150000
    ELSE 75000
  END::numeric;
$FN$;

-- True when the ask is at or above 1x the revenue floor.
CREATE OR REPLACE FUNCTION bf_readiness_over_ask(
  p_annual_revenue_range text,
  p_requested numeric
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $FN$
  SELECT CASE
    WHEN p_requested IS NULL OR p_requested <= 0 THEN false
    ELSE p_requested >= bf_readiness_revenue_floor(p_annual_revenue_range)
  END;
$FN$;

-- Replaces the 1-arg tier function from BF_SERVER_READINESS_SCORE_v1. Same bands
-- (green >= 50, yellow 30-49, red < 30) but green is unreachable on an over-ask.
CREATE OR REPLACE FUNCTION bf_readiness_tier(
  p_score integer,
  p_over_ask boolean
) RETURNS text LANGUAGE sql IMMUTABLE AS $FN$
  SELECT CASE
    WHEN p_score >= 50 AND coalesce(p_over_ask, false) THEN 'yellow'  -- capped
    WHEN p_score >= 50 THEN 'green'
    WHEN p_score >= 30 THEN 'yellow'
    ELSE 'red'
  END;
$FN$;

-- Re-grade every row, including the ones the previous migration already scored.
UPDATE readiness_sessions
   SET readiness_over_ask = bf_readiness_over_ask(annual_revenue_range, requested_amount),
       readiness_tier = bf_readiness_tier(
         coalesce(readiness_score, bf_readiness_score(
           sales_history_years, annual_revenue_range, fixed_assets_value_range,
           accounts_receivable_range, requested_amount)),
         bf_readiness_over_ask(annual_revenue_range, requested_amount)),
       updated_at = now();

-- Drop the old 1-arg tier function. Creating the 2-arg version above only ADDS an
-- overload; leaving the 1-arg one in place would let any caller silently keep computing
-- an UNCAPPED tier. website.controller.ts is updated in the same block to pass both args.
DROP FUNCTION IF EXISTS bf_readiness_tier(integer);
