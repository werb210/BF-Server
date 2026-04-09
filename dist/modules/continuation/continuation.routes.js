import { Router } from "express";
import { db } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import { logWarn } from "../../observability/logger.js";
const router = Router();
router.get("/", requireAuth, async (req, res, next) => {
    if (!req.user?.userId) {
        res.status(401).json({ ok: false, error: "invalid_token" });
        return;
    }
    try {
        const { rows } = await db.query(`
        select id, current_step, metadata
        from applications
        where owner_user_id = $1
          and is_completed = false
        order by last_updated desc nulls last, updated_at desc
        limit 1
      `, [req.user.userId]);
        const latest = rows[0];
        if (!latest) {
            res.status(200).json({ exists: false });
            return;
        }
        res.status(200).json({
            exists: true,
            applicationId: latest.id,
            step: latest.current_step ?? 1,
            data: latest.metadata ?? {},
        });
    }
    catch (error) {
        logWarn("application_continuation_lookup_failed", {
            message: error instanceof Error ? error.message : "unknown_error",
        });
        res.status(500).json({
            ok: false,
            error: "internal_error",
            message: "Failed to load continuation session",
        });
    }
});
export default router;
