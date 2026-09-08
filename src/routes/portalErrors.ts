// BF_SERVER_PORTAL_ERRORS_v1
import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";

const router = Router();

router.use(requireAuth);

const schema = z.object({
  source: z.enum(["boundary", "unhandledrejection", "runtime"]),
  message: z.string().trim().min(1).max(2000),
  stack: z.string().max(8000).nullable().optional(),
  url: z.string().max(500).nullable().optional(),
  userAgent: z.string().max(500).nullable().optional(),
  context: z.record(z.unknown()).nullable().optional(),
});

/**
 * POST /api/portal/errors
 * Staff-side crash reporting. Deliberately separate from the public applicant
 * issue channel so portal crashes do not enter customer triage or lose stacks.
 */
router.post(
  "/",
  safeHandler(async (req: any, res: any) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid error payload.", 400);
    }

    const { source, message, stack, url, userAgent, context } = parsed.data;
    // Line numbers shift between builds; message plus the top frame is what
    // identifies the defect. Matches the client-side fingerprint intent.
    const topFrame = (stack ?? "").split("\n")[1]?.trim() ?? "";
    const fingerprint = createHash("sha256")
      .update(`${message}::${topFrame}`)
      .digest("hex");

    await pool.query(
      `INSERT INTO portal_errors
         (fingerprint, source, message, stack, url, user_agent, user_id, silo, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (fingerprint) DO UPDATE
         SET occurrences = portal_errors.occurrences + 1,
             last_seen_at = now()`,
      [
        fingerprint,
        source,
        message,
        stack ?? null,
        url ?? null,
        userAgent ?? null,
        String(req.user?.userId ?? req.user?.id ?? ""),
        getSilo(res) ?? "BF",
        context ? JSON.stringify(context) : null,
      ],
    );

    res.status(202).json({ status: "ok" });
  }),
);

/** GET /api/portal/errors — most-recent-first, for a staff triage view. */
router.get(
  "/",
  safeHandler(async (req: any, res: any) => {
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit ?? 50) || 50));
    const { rows } = await pool.query(
      `SELECT id, fingerprint, source, message, stack, url, user_id, silo,
              occurrences, first_seen_at, last_seen_at
         FROM portal_errors
        ORDER BY last_seen_at DESC
        LIMIT $1`,
      [limit],
    );

    res.json({ errors: rows });
  }),
);

export default router;
