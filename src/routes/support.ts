import express from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";

const router = express.Router();

// BF_SERVER_v789_PUBLIC_RATE_LIMITS - public and unauthenticated: 5 a minute per IP.
const supportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "RATE_LIMITED" },
  keyGenerator: rateLimitKeyFromRequest, // BF_SERVER_v791_RATE_LIMIT_KEYS - no validate overrides
});

// BF_SERVER_BLOCK_v332_SETTINGS_AND_AUDIT_HARDENING_v1 -- Edit 12
// Pre-fix this router declared its route as router.post("/support"), and
// routeRegistry.ts:153 mounts the router at "/support", so the resulting
// URL was /api/support/support -- inaccessible. No production UI hits
// /api/support/support and no caller hits the intended /api/support path
// either (verified across BF-portal, BF-client, BF-Website). The route is
// effectively dead. Renaming the internal path to "/" makes the live URL
// /api/support, matching the mount point.
router.post("/", supportLimiter, async (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const result = await pool.query(
      `INSERT INTO live_chat_requests (name, email, message)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name || null, email || null, message]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Support route error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
