// BF_SERVER_SUBMIT_FUNNEL_v1
// v842 created submit_attempts to catch submissions that die in the browser and
// never reach the server. It has been collecting since June and nothing reads
// it. These endpoints answer two questions: what fraction of applicants who tap
// Submit actually complete, and what is stopping the rest.
import { Router } from "express";
import { pool } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { safeHandler } from "../../middleware/safeHandler.js";

const router = Router();
router.use(requireAuth);

function days(value: unknown, fallback = 30): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 365 ? Math.floor(n) : fallback;
}

/** GET /api/admin/submit-funnel?days=30 — completion rate over time. */
router.get(
  "/submit-funnel",
  safeHandler(async (req: any, res: any) => {
    const window = days(req.query?.days);

    const totals = await pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count
         FROM submit_attempts
        WHERE created_at >= now() - ($1 || ' days')::interval
        GROUP BY status`,
      [window],
    );

    const byStatus: Record<string, number> = {};
    for (const row of totals.rows) byStatus[row.status] = Number(row.count);
    const attempted = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const completed = byStatus.completed ?? 0;

    const daily = await pool.query(
      `SELECT date_trunc('day', created_at)::date AS day,
              COUNT(*)::text AS attempts,
              COUNT(*) FILTER (WHERE status = 'completed')::text AS completed
         FROM submit_attempts
        WHERE created_at >= now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY 1`,
      [window],
    );

    res.json({
      windowDays: window,
      attempted,
      completed,
      // The number that matters: of everyone who tapped Submit, how many arrived.
      completionRate: attempted ? Number((completed / attempted).toFixed(4)) : null,
      byStatus,
      daily: daily.rows,
    });
  }),
);

/** GET /api/admin/submit-failures?days=30 — what is stopping them. */
router.get(
  "/submit-failures",
  safeHandler(async (req: any, res: any) => {
    const window = days(req.query?.days);

    const grouped = await pool.query(
      `SELECT COALESCE(error, '(no error reported — died before it could report)') AS error,
              COUNT(*)::text AS count,
              MAX(created_at) AS latest
         FROM submit_attempts
        WHERE status <> 'completed'
          AND created_at >= now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 50`,
      [window],
    );

    // A stuck row still has the applicant's phone and business name, so these
    // are people who can be called back rather than anonymous funnel loss.
    const recent = await pool.query(
      `SELECT id, application_token, phone, business_name, status, error,
              user_agent, silo, created_at
         FROM submit_attempts
        WHERE status <> 'completed'
          AND created_at >= now() - ($1 || ' days')::interval
        ORDER BY created_at DESC LIMIT 100`,
      [window],
    );

    res.json({ windowDays: window, grouped: grouped.rows, recent: recent.rows });
  }),
);

export default router;
