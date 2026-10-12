import { Router } from "express";
import rateLimit from "express-rate-limit";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js"; // BF_SERVER_v791_RATE_LIMIT_KEYS
import { submitContactForm } from "../modules/website/contact.controller.js";
import { submitCreditReadiness } from "../modules/website/website.controller.js";
import { config } from "../config/index.js";

const router = Router();

const websiteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.env === "test",
  keyGenerator: rateLimitKeyFromRequest, // BF_SERVER_v791_RATE_LIMIT_KEYS
});

const websiteBodyLimitBytes = 64 * 1024;

// BF_SERVER_BLOCK_v332_SETTINGS_AND_AUDIT_HARDENING_v1 -- Edit 8
// Limiter was disabled "while Azure proxy/rate limit behavior is stabilized"
// (no date attached). app.set('trust proxy', 1) is set in server.ts so
// req.ip resolves correctly through Azure App Service's reverse proxy, and
// safeKeyGenerator handles the IPv6/X-Forwarded-For edge cases. The
// remaining concern was that Azure's health probes would consume the
// budget, but the global limiter at server.ts:95 already skips /health and
// /metrics, and this router's limiter only fires for /api/website/* paths
// which probes don't hit. Re-enabling: 20 req/min/IP is generous for a
// public form and matches /api/credit/score's new limit.
router.use(websiteLimiter);
router.use((req: any, res: any, next: any) => {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > websiteBodyLimitBytes) {
    res.status(413).json({ error: "Payload too large" });
    return;
  }
  next();
});

router.post("/credit-readiness", submitCreditReadiness);
router.post("/contact", submitContactForm);

export default router;
