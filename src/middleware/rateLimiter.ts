import rateLimit from "express-rate-limit";
import { rateLimitKeyFromRequest } from "./clientIp.js";

export const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyFromRequest,
});

export const contactRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many requests, try again later",
  keyGenerator: rateLimitKeyFromRequest,
});
