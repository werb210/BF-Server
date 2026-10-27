import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { AppError } from "../middleware/errors.js";
import rateLimit from "express-rate-limit";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";

const router = Router();

// BF_SERVER_v789_PUBLIC_RATE_LIMITS - public and unauthenticated: 5 reports a
// minute per IP, and a screenshot of at most 5 MB (decoded).
const clientIssuesLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "RATE_LIMITED" },
  keyGenerator: rateLimitKeyFromRequest, // BF_SERVER_v791_RATE_LIMIT_KEYS - no validate overrides
});

export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

// Decoded byte size of a base64 payload, with or without a data: URL prefix.
export function base64DecodedBytes(value: string): number {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const b64 = (comma >= 0 ? value.slice(comma + 1) : value).replace(/\s+/g, "");
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

const schema = z.object({
  message: z.string().trim().min(1).max(4000),
  screenshotBase64: z.string().optional(),
  applicationId: z.guid().optional(),
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
  clientIssuesLimiter,
  safeHandler(async (req: any, res: any) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid issue payload.", 400);
    }

    const { message, screenshotBase64, applicationId, contactPhone } = parsed.data;
    if (screenshotBase64 && base64DecodedBytes(screenshotBase64) > MAX_SCREENSHOT_BYTES) {
      res.status(413).json({ error: "screenshot_too_large", maxBytes: MAX_SCREENSHOT_BYTES });
      return;
    }
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
