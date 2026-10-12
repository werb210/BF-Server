import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clientIpForRateLimit } from "./authRateLimit.js";

// BF_SERVER_v789_XFF_KEY
// Keying on the LEFT-most X-Forwarded-For entry let a caller forge a new address per
// request and never hit any limiter built on this generator. Azure appends the real
// caller on the RIGHT, so reuse authRateLimit's right-to-left walk (first public hop,
// port stripped, falling back to req.ip, which honours trust proxy 1). ipKeyGenerator
// collapses IPv6 to its /64.
function safeKeyGenerator(req: any): string {
  const ip = clientIpForRateLimit({
    headers: req?.headers ?? {},
    ip: req?.ip,
    socket: req?.socket,
  } as any).replace(/^::ffff:/i, "");
  return ipKeyGenerator(ip || "unknown");
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
