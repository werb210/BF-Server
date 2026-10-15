// BF_SERVER_v789_ANALYTICS_COLLECTOR - public product-analytics collector for BF-client.
// Mounted at /api/analytics (routeRegistry), unauthenticated (visitors have no token)
// and rate limited to 60 requests/min per client IP. Accepts
//   { event | name, properties?, session_id | sessionId }
// and appends one analytics_events row (baseline table; event, metadata, ip, user_agent).
// Contact details never reach the table: property keys that name an email or phone are
// dropped, and any value that looks like an email address or phone number is redacted.
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { clientIpFromRequest, rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { logAnalyticsEvent } from "../services/analyticsService.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { safeHandler } from "../middleware/safeHandler.js"; // BF_SERVER_v789_SAFE_HANDLERS

export const ANALYTICS_RATE_LIMIT_PER_MIN = 60;
export const REDACTED = "[redacted]";

const CONTACT_WORDS = new Set(["email", "mail", "phone", "mobile", "cell", "cellphone", "telephone", "tel", "sms", "fax", "msisdn", "whatsapp"]);
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// NANP (with or without +1, any common separators) and any "+<country><digits>" international form.
const PHONE_RE = /(?<![\w+])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w])|\+\d[\d\s().-]{7,}\d/g;

export function isContactKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z]/g, "");
  if (flat.includes("email") || flat.includes("phone")) return true;
  const words = key.split(/(?=[A-Z][a-z])|[^A-Za-z]+/).map((w) => w.toLowerCase()).filter(Boolean);
  return words.some((w) => CONTACT_WORDS.has(w));
}

export function redactContactText(value: string): string {
  return value.replace(EMAIL_RE, REDACTED).replace(PHONE_RE, REDACTED);
}

function cleanValue(v: unknown, depth: number): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    // A bare 10/11-digit integer is as likely a phone number as anything else.
    const digits = String(Math.trunc(Math.abs(v)));
    return Number.isInteger(v) && (digits.length === 10 || (digits.length === 11 && digits.startsWith("1"))) ? REDACTED : v;
  }
  if (typeof v === "string") return redactContactText(v.slice(0, 500));
  if (depth >= 3) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => cleanValue(x, depth + 1));
  if (typeof v === "object") return sanitizeProperties(v, depth + 1);
  return null;
}

export function sanitizeProperties(input: unknown, depth = 0): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= 50) break;
    if (isContactKey(k)) continue;
    const cleaned = cleanValue(v, depth);
    if (cleaned === undefined) continue;
    out[k.slice(0, 64)] = cleaned;
    n++;
  }
  return out;
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

export function buildAnalyticsRouter(): Router {
  const router = Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: ANALYTICS_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyFromRequest,
    message: { ok: false, error: "rate_limited" },
  });
  router.use(limiter);
  router.use(express.json({ limit: "32kb" }));

  router.get("/", (_req: any, res: any) => {
    res.status(200).json({ ok: true });
  });

  router.post("/", safeHandler(async (req: any, res: any) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    // BF_SERVER_v811_MOBILE_APPS_REPORT - BF-client's trackEvent posts { event_name, payload }; accept that shape too
    // (it was answered with 400 and never stored).
    const rawEvent = str(b.event, 100) ?? str(b.name, 100) ?? str(b.event_name, 100);
    if (!rawEvent) return res.status(400).json({ ok: false, error: "event_required" });
    const event = redactContactText(rawEvent);
    const payload = b.payload && typeof b.payload === "object" && !Array.isArray(b.payload) ? b.payload : null;
    const rawSession = str(b.session_id, 100) ?? str(b.sessionId, 100) ?? str(payload?.session_id, 100);
    const sessionId = rawSession && redactContactText(rawSession) === rawSession ? rawSession : null;
    const properties = sanitizeProperties(b.properties ?? payload);
    try {
      await logAnalyticsEvent({
        event,
        metadata: { source: "bf-client", session_id: sessionId, properties },
        ip: clientIpFromRequest(req),
        userAgent: str(req.headers?.["user-agent"], 300) ?? undefined,
      });
    } catch (err) {
      // Tracking must never break the page; leave a trace and answer normally.
      logWarnSwallowed(err, "routes/analytics.ts:insert");
      return res.status(202).json({ ok: true, stored: false });
    }
    return res.status(202).json({ ok: true });
  }));

  return router;
}

export default buildAnalyticsRouter();
