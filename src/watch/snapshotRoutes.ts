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

    // Missed since the start of today in the server's timezone: a complication
    // showing a running all-time total would be useless.
    const missed = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM call_logs
        WHERE user_id = $1
          AND disposition = 'missed'
          AND created_at >= date_trunc('day', now())`,
      [userId],
    ).catch(() => ({ rows: [{ count: "0" }] }));

    res.json({
      status: presence.rows[0]?.status ?? "away",
      missedCalls: Number(missed.rows[0]?.count ?? 0),
      asOf: new Date().toISOString(),
    });
  }),
);

export default router;
