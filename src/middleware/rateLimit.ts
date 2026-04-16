import rateLimit, { ipKeyGenerator } from "express-rate-limit";

function safeKeyGenerator(req: any): string {
  const forwarded = req.headers["x-forwarded-for"];
  const rawIp = typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : (req.ip ?? "unknown");

  const withoutV4Mapped = rawIp.replace(/^::ffff:/, "");
  const cleanIp = /^\d+\.\d+\.\d+\.\d+:\d+$/.test(withoutV4Mapped)
    ? withoutV4Mapped.split(":")[0]
    : withoutV4Mapped;

  return ipKeyGenerator(cleanIp || rawIp);
}

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: safeKeyGenerator,
  validate: {
    xForwardedForHeader: false,
    trustProxy: false,
  },
});

// Backward-compatible aliases for existing imports.
export const globalRateLimit = globalLimiter;
export const apiRateLimit = () => rateLimit({
  windowMs: 60_000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: safeKeyGenerator,
});
export const documentUploadRateLimit = globalLimiter;
export const clientSubmissionRateLimit = globalLimiter;
export const lenderSubmissionRateLimit = globalLimiter;

export function pushSendRateLimit() {
  return (_req: any, _res: any, next: any) => next();
}

export function adminRateLimit() {
  return (_req: any, _res: any, next: any) => next();
}

export const voiceRateLimit = () => globalLimiter;
export const portalRateLimit = () => rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: safeKeyGenerator,
});
export const authRateLimit = () => rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: safeKeyGenerator,
});
export const clientReadRateLimit = () => globalLimiter;
export const clientDocumentsRateLimit = () => globalLimiter;

export const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: safeKeyGenerator,
  validate: {
    xForwardedForHeader: false,
    trustProxy: false,
  },
});

export { safeKeyGenerator };
