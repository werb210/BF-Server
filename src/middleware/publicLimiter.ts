import { rateLimit } from "express-rate-limit";
import { rateLimitKeyFromRequest } from "./clientIp.js";

export const publicLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  message: { error: "RATE_LIMITED" },
  keyGenerator: rateLimitKeyFromRequest,
  validate: {
    xForwardedForHeader: false,
    trustProxy: false,
  },
});
