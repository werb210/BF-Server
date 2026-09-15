// BF_SERVER_WATCH_SNAPSHOT_v1
// The Watch complication reads presence.status and calls.missed from a shared
// app group that nothing populates. The iPhone app is the writer; this gives it
// both values in one call so a foreground refresh is not two round trips on a
// cellular connection.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";

const router = Router();
router.use(requireAuth);

router.get(
  "/snapshot",
  safeHandler(async (req: any, res: any) => {
    const userId = String(req.user?.userId ?? req.user?.id ?? "");

    const presence = await pool.query<{ status: string }>(
      `SELECT status FROM user_presence WHERE user_id = $1 LIMIT 1`,
      [userId],
    ).catch(() => ({ rows: [] as { status: string }[] }));

    // BF_SERVER_WATCH_SNAPSHOT_TASKS_v209
    // This query was broken from the day it shipped and failed silently. It read
    // call_logs.user_id, which does not exist - the column is staff_user_id - and
    // matched the nonexistent 'missed' disposition, which is not one of the nine values in
    // CALL_DISPOSITIONS. So it threw, hit the catch, and the complication has
    // shown zero missed calls permanently.
    //
    // Missed calls are recorded as call_events rows with event_type 'call.missed',
    // which is the source /staff/daily-briefing already uses correctly.
    const missed = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM call_events
        WHERE user_id = $1::uuid
          AND event_type = 'call.missed'
          AND created_at >= date_trunc('day', now())`,
      [userId],
    ).catch(() => ({ rows: [{ count: "0" }] }));

    // Tasks due today or already overdue, assigned to or owned by this user.
    // Overdue is included deliberately: a count that drops something the moment
    // it is late is worse than no count at all.
    const tasksDue = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM crm_tasks
        WHERE (assigned_to = $1::uuid OR owner_id = $1::uuid)
          AND due_at IS NOT NULL
          AND due_at < date_trunc('day', now()) + interval '1 day'
          AND lower(COALESCE(status, '')) NOT IN ('done', 'completed', 'complete', 'closed', 'cancelled')`,
      [userId],
    ).catch(() => ({ rows: [{ count: "0" }] }));

    res.json({
      status: presence.rows[0]?.status ?? "away",
      missedCalls: Number(missed.rows[0]?.count ?? 0),
      tasksDue: Number(tasksDue.rows[0]?.count ?? 0),
      asOf: new Date().toISOString(),
    });
  }),
);

export default router;
