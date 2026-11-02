// BF_SERVER_v868_QUEBEC_CONSENT - privacy helpers for the public apps (ported from KS-server #42).
//   GET /api/privacy/region   public: { region: "QC" | "other" | "unknown" } for the visitor's IP address.
// Quebec's Law 25 needs consent before Google Analytics / Google Ads cookies are set; the client app and the
// website ask this first and start Google Consent Mode "denied" only in Quebec. The answer is the same for
// every silo (it is about the visitor, not about CRM data). The address is never logged, stored or returned.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { safeHandler } from "../middleware/safeHandler.js";
import { clientIpFromRequest, rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { regionResolver } from "../privacy/region.js";

const router = Router();

const regionLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });
router.get("/region", regionLimiter, safeHandler(async (req: any, res: any) => {
  let ip = "";
  try { ip = clientIpFromRequest(req); } catch { ip = ""; }
  const region = await regionResolver().resolve(ip);
  // Per-visitor answer: browsers may keep it a few minutes, shared caches never.
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.json({ region });
}));

export default router;
