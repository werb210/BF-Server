// BF_SERVER_WIDGET_SUMMARY_v41
// One small payload for a home-screen widget: pipeline count, tasks due today,
// unread messages, commission earned. A widget refreshes on the system's
// schedule, in the background, on a device that may be asleep - so it gets ONE
// cheap authenticated call, not four.
//
// Every figure here is deliberately the same figure the portal already shows.
// A widget that disagrees with the dashboard is worse than no widget, so the
// commission expression below is copied from GET /api/dashboard/metrics rather
// than rewritten: 2% unless the lender product carries an override.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";
import { ApplicationStage } from "../modules/applications/pipelineState.js";

const router = Router();

// The board's own definition of a real deal: no companion legs, no drafts, no
// nameless rows. Kept here as one constant so the application counts cannot
// drift apart from each other the way they would if each query spelled it out.
const REAL_DEAL = `
  a.parent_application_id IS NULL
  AND COALESCE(a.pipeline_state, '') NOT IN ('draft', 'Draft', '')
  AND COALESCE(NULLIF(TRIM(a.name), ''), NULLIF(TRIM(a.business_legal_name), '')) IS NOT NULL
  AND LOWER(TRIM(COALESCE(a.name, a.business_legal_name, ''))) NOT IN ('draft', 'draft application')`;

router.get("/summary", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const userId = req.user?.id ?? req.user?.userId ?? null;

  const [pipeline, tasksDue, unread, earned] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM applications a
        WHERE UPPER(a.silo) = UPPER($1) AND ${REAL_DEAL}`,
      [silo],
    ),

    // Tasks the signed-in user owes today. Unassigned tasks count too: on a
    // small team an unclaimed call due today is still someone's problem, and a
    // widget reading zero while the Tasks page shows work is a trust problem.
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tasks t
        WHERE t.silo = $1
          AND t.deleted_at IS NULL
          AND t.status <> 'COMPLETED'
          AND t.due_at::date <= now()::date
          AND (t.assignee_user_id = $2 OR t.assignee_user_id IS NULL)`,
      [silo, userId],
    ),

    // Inbound and unread, matching the Messages list: a deleted contact sets
    // contact_id to NULL, and those orphaned threads are hidden there too.
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM communications_messages m
        WHERE m.silo = $1
          AND m.read_at IS NULL
          AND m.direction = 'inbound'
          AND m.contact_id IS NOT NULL`,
      [silo],
    ),

    // Commission on funded deals only - the Accepted bucket. Same expression
    // as the dashboard: funded amount, accepted term sheet, or amount asked;
    // converted to CAD; 2% unless the product overrides it.
    pool.query<{ commission: string }>(
      `SELECT COALESCE(SUM(
                (COALESCE(a.funded_amount, off.amount, a.requested_amount, 0)
                   * COALESCE((SELECT to_cad FROM fx_rates WHERE currency = a.funded_currency), 1))
                * (COALESCE(lp.commission, 2) / 100.0)
              ), 0)::text AS commission
         FROM applications a
         LEFT JOIN lender_products lp ON lp.id = a.lender_product_id::text
         LEFT JOIN LATERAL (
           SELECT o.amount FROM offers o
            WHERE o.application_id = a.id AND o.status = 'accepted'
            ORDER BY o.updated_at DESC NULLS LAST
            LIMIT 1
         ) off ON TRUE
        WHERE UPPER(a.silo) = UPPER($1)
          AND (a.pipeline_state = $2 OR a.funded_amount IS NOT NULL)
          AND ${REAL_DEAL}`,
      [silo, ApplicationStage.ACCEPTED],
    ),
  ]);

  const num = (value: string | undefined) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  res.json({
    silo,
    pipelineCount: num(pipeline.rows[0]?.count),
    tasksDueToday: num(tasksDue.rows[0]?.count),
    unreadMessages: num(unread.rows[0]?.count),
    commissionEarned: Math.round(num(earned.rows[0]?.commission)),
    currency: "CAD",
    // A widget renders whatever it last fetched, possibly for hours. This lets
    // it say "as of 9:14" rather than presenting stale numbers as current.
    asOf: new Date().toISOString(),
  });
}));

export default router;
