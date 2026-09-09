// BF_SERVER_AD_SPEND_ANALYSIS_v1
// googleAdsWarehouse pulls search_term_view daily into google_ads_daily and
// nothing reads it. These are the two questions that decide budget: what are we
// paying for that never converts, and what actually works.
import { Router } from "express";
import { pool } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { safeHandler } from "../../middleware/safeHandler.js";

const router = Router();
router.use(requireAuth);

function days(value: unknown, fallback = 90): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 730 ? Math.floor(n) : fallback;
}

/**
 * GET /api/marketing/ad-waste?days=90
 * Search terms that took money and returned nothing, worst first.
 */
router.get(
  "/ad-waste",
  safeHandler(async (req: any, res: any) => {
    const window = days(req.query?.days);

    const waste = await pool.query(
      `SELECT name AS search_term,
              SUM(cost)::numeric(12,2)   AS cost,
              SUM(clicks)::int           AS clicks,
              SUM(impressions)::int      AS impressions,
              SUM(conversions)::numeric(10,2) AS conversions
         FROM google_ads_daily
        WHERE level = 'search_term'
          AND stat_date >= (now() - ($1 || ' days')::interval)::date
        GROUP BY name
       HAVING SUM(conversions) = 0 AND SUM(cost) > 0
        ORDER BY SUM(cost) DESC
        LIMIT 100`,
      [window],
    );

    const working = await pool.query(
      `SELECT name AS search_term,
              SUM(cost)::numeric(12,2)   AS cost,
              SUM(clicks)::int           AS clicks,
              SUM(conversions)::numeric(10,2) AS conversions,
              (SUM(cost) / NULLIF(SUM(conversions), 0))::numeric(12,2) AS cost_per_conversion
         FROM google_ads_daily
        WHERE level = 'search_term'
          AND stat_date >= (now() - ($1 || ' days')::interval)::date
        GROUP BY name
       HAVING SUM(conversions) > 0
        ORDER BY SUM(conversions) DESC
        LIMIT 100`,
      [window],
    );

    const totals = await pool.query<{
      total_cost: string; wasted_cost: string; total_conversions: string;
    }>(
      `SELECT COALESCE(SUM(cost), 0)::text AS total_cost,
              COALESCE(SUM(cost) FILTER (WHERE conv_zero), 0)::text AS wasted_cost,
              COALESCE(SUM(conversions), 0)::text AS total_conversions
         FROM (
           SELECT name, SUM(cost) AS cost, SUM(conversions) AS conversions,
                  SUM(conversions) = 0 AS conv_zero
             FROM google_ads_daily
            WHERE level = 'search_term'
              AND stat_date >= (now() - ($1 || ' days')::interval)::date
            GROUP BY name
         ) t`,
      [window],
    );

    const t = totals.rows[0];
    const total = Number(t?.total_cost ?? 0);
    const wasted = Number(t?.wasted_cost ?? 0);

    res.json({
      windowDays: window,
      totalCost: total,
      wastedCost: wasted,
      // The headline: what share of spend produced nothing at all.
      wastedShare: total ? Number((wasted / total).toFixed(4)) : null,
      totalConversions: Number(t?.total_conversions ?? 0),
      worstOffenders: waste.rows,
      whatWorks: working.rows,
    });
  }),
);

/**
 * GET /api/marketing/ad-keywords?days=90
 * The same view by bid keyword rather than by what people actually typed.
 * A keyword that performs while its search terms do not means the match type
 * is too loose.
 */
router.get(
  "/ad-keywords",
  safeHandler(async (req: any, res: any) => {
    const window = days(req.query?.days);
    const rows = await pool.query(
      `SELECT name AS keyword,
              SUM(cost)::numeric(12,2) AS cost,
              SUM(clicks)::int AS clicks,
              SUM(conversions)::numeric(10,2) AS conversions,
              (SUM(cost) / NULLIF(SUM(clicks), 0))::numeric(10,2) AS cost_per_click
         FROM google_ads_daily
        WHERE level = 'keyword'
          AND stat_date >= (now() - ($1 || ' days')::interval)::date
        GROUP BY name
        ORDER BY SUM(cost) DESC
        LIMIT 100`,
      [window],
    );
    res.json({ windowDays: window, keywords: rows.rows });
  }),
);

export default router;
