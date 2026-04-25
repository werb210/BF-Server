import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { AppError } from "../middleware/errors.js";

const router = Router();

const schema = z.object({
  message: z.string().trim().min(1).max(4000),
  screenshotBase64: z.string().optional(),
  applicationId: z.string().uuid().optional(),
  contactPhone: z.string().trim().optional(),
});

/**
 * POST /api/client/issues
 * Public endpoint — the client wizard's "Report an Issue" button posts
 * here. Persists the report so staff can triage. No auth required;
 * this is intentionally a low-friction reporting channel.
 */
router.post(
  "/",
  safeHandler(async (req: any, res: any) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid issue payload.", 400);
    }

    const { message, screenshotBase64, applicationId, contactPhone } = parsed.data;
    const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
    const url = (req.headers.referer as string | undefined) ?? null;

    const result = await pool.query<{ id: string }>(
      `INSERT INTO client_issues
         (application_id, contact_phone, message, screenshot_b64, user_agent, url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [applicationId ?? null, contactPhone ?? null, message, screenshotBase64 ?? null, userAgent, url]
    );

    res.status(201).json({
      status: "ok",
      data: { id: result.rows[0]?.id ?? null, received: true },
    });
  })
);

export default router;
