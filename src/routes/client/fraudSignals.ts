// BF_SERVER_v846_FRAUD - POST /api/client/fraud-signals: the client app's device and behaviour beacon (checks 9, 10).
// Public (the wizard calls it right after a successful submit), rate limited, and
// it always answers 202 so the beacon can never interfere with the application. See src/fraud/deviceSignals.ts for
// exactly what is accepted and stored.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../../db.js";
import { rateLimitKeyFromRequest } from "../../middleware/clientIp.js";
import type { Q } from "../../fraud/types.js";
import { parseSignals, recordSignals } from "../../fraud/deviceSignals.js";
import { ipinfoProvider } from "../../fraud/providers/lookups.js";

const router = Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "RATE_LIMITED" },
  keyGenerator: rateLimitKeyFromRequest,
});

router.post("/fraud-signals", limiter, (req, res) => {
  const parsed = parseSignals(req.body);
  res.status(202).json({ ok: true });
  if (!parsed) return;
  void (async () => {
    try {
      const db = pool as unknown as Q;
      await recordSignals(db, parsed, { ip: req.ip ?? null, ipIntel: ipinfoProvider() });
    } catch (err) {
      console.warn("[fraud] device signals not stored", { message: (err as Error)?.message ?? String(err) });
    }
  })();
});

export default router;
