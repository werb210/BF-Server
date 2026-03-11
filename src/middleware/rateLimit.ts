import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import { rateLimitKeyFromRequest } from "./clientIp";

const oneMinute = 60 * 1000;

function isEnabled(): boolean {
  if (process.env.NODE_ENV === "production") {
    return true;
  }
  return process.env.RATE_LIMIT_ENABLED !== "false";
}

function makeLimiter(max: number, windowMs = oneMinute): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !isEnabled() || process.env.NODE_ENV === "test",
    keyGenerator: rateLimitKeyFromRequest,
  });
}

const loginLimiter = makeLimiter(20);
const otpLimiter = makeLimiter(20);

export const apiLimiter = makeLimiter(200, 15 * 60 * 1000);
export const publicLimiter = makeLimiter(200, 15 * 60 * 1000);
export const strictLimiter = makeLimiter(25, 15 * 60 * 1000);

export const adminRateLimit = (max = 120, windowMs = oneMinute) => makeLimiter(max, windowMs);
export const portalRateLimit = (max = 120, windowMs = oneMinute) => makeLimiter(max, windowMs);
export const voiceRateLimit = (max = 60, windowMs = oneMinute) => makeLimiter(max, windowMs);
export const loginRateLimit = () => loginLimiter;
export const otpRateLimit = () => otpLimiter;
export function resetOtpRateLimit(key?: string): void {
  if (!key) {
    otpLimiter.resetKey?.("::/0");
    return;
  }
  otpLimiter.resetKey?.(key);
}
export const refreshRateLimit = (max = 30, windowMs = oneMinute) => makeLimiter(max, windowMs);
export const documentUploadRateLimit = (max = 30, windowMs = oneMinute) =>
  makeLimiter(max, windowMs);
export const clientSubmissionRateLimit = (max = 40, windowMs = oneMinute) =>
  makeLimiter(max, windowMs);
export const lenderSubmissionRateLimit = (max = 40, windowMs = oneMinute) =>
  makeLimiter(max, windowMs);
export const clientReadRateLimit = (max = 120, windowMs = oneMinute) =>
  makeLimiter(max, windowMs);
export const clientDocumentsRateLimit = (max = 40, windowMs = oneMinute) =>
  makeLimiter(max, windowMs);
export const pushSendRateLimit = (max = 30, windowMs = oneMinute) => makeLimiter(max, windowMs);
export const otpSendLimiter = (max = 20, windowMs = oneMinute) => makeLimiter(max, windowMs);
export const otpVerifyLimiter = (max = 20, windowMs = oneMinute) => makeLimiter(max, windowMs);

export function resetLoginRateLimit(key?: string): void {
  if (!key) {
    loginLimiter.resetKey?.("::/0");
    return;
  }
  loginLimiter.resetKey?.(key);
}
