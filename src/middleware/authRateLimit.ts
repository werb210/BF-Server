// BF_SERVER_AUTH_RATE_LIMIT_v1
// /api/auth/otp/start and /otp/verify had NO rate limiting whatsoever. Sending an OTP
// costs real money (Twilio) and texts a code to a third party, so /otp/start is the most
// abusable unauthenticated endpoint in the system. /otp/verify is the brute-force surface
// (a 6-digit code is 1,000,000 combinations); its only protection was a 5-attempt cap in
// an in-memory Map in auth.service.ts, which resets on every deploy and does not span App
// Service instances - not a real control.
//
// This lives in its own module ON PURPOSE. middleware/rateLimiter.ts exports publicLimiter
// with a custom keyGenerator built on rateLimitKeyFromRequest(), which strips a trailing
// :port with /:\d+$/ and therefore CORRUPTS IPv6 addresses (it eats the last hextet).
// express-rate-limit v8 rejects that with ERR_ERL_KEY_GEN_IPV6. publicLimiter is mounted
// nowhere, so the fault never surfaced - but merely IMPORTING that module runs its
// validation and throws on every request. Importing this file instead leaves that
// landmine untouched.
//
// No custom keyGenerator here: the library default already honours
// app.set("trust proxy", 1) and collapses IPv6 to its /64 prefix, so an attacker cannot
// rotate addresses within a /64 to evade the limit.
import rateLimit from "express-rate-limit";
import { isTest } from "../config/runtime.js";

export const otpStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", message: "Too many code requests. Try again later." },
  skip: () => isTest, // the suite fires many OTPs from one IP
});

export const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", message: "Too many attempts. Try again later." },
  skip: () => isTest,
});
