import { rateLimit } from "express-rate-limit";

export const publicLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  message: { error: "RATE_LIMITED" },
});
