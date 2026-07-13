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
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import { isTest } from "../config/runtime.js";

// BF_SERVER_AUTH_RATE_LIMIT_v2
// Azure App Service hands Express a req.ip WITH THE PORT ATTACHED ("77.246.52.163:62553").
// express-rate-limit's default key generator rejects that outright:
//   ValidationError: An invalid 'request.ip' (77.246.52.163:62553) was detected
//   ERR_ERL_INVALID_IP_ADDRESS
// which THREW on every hit to the OTP endpoints - i.e. nobody could log in.
//
// The pre-existing rateLimitKeyFromRequest() stripped the port with /:\d+$/, which fixes
// IPv4 but CORRUPTS IPv6 by eating the last hextet, and the library then rejects THAT with
// ERR_ERL_KEY_GEN_IPV6. Both failure modes are live landmines, so strip the port in a way
// that understands both families, then hand the bare address to the library's own
// ipKeyGenerator, which collapses IPv6 to its /64 prefix (an attacker with a /64 otherwise
// has ~18 quintillion addresses to rotate through and evade the limit).
export function stripPort(raw: string): string {
  const ip = String(raw ?? "").trim();
  if (!ip) return "";
  // Bracketed IPv6 with port: [2001:db8::1]:443
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(ip);
  if (bracketed) return bracketed[1] ?? "";
  // Bare IPv6 has 2+ colons and never carries a port in this form - leave it alone.
  if ((ip.match(/:/g) ?? []).length >= 2) return ip;
  // IPv4, optionally with :port
  return ip.replace(/:\d+$/, "");
}

function keyFromRequest(req: Request): string {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  const raw = fwd || req.ip || req.socket?.remoteAddress || "";
  return ipKeyGenerator(stripPort(raw));
}

export const otpStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", message: "Too many code requests. Try again later." },
  keyGenerator: keyFromRequest, // BF_SERVER_AUTH_RATE_LIMIT_v2
  skip: () => isTest, // the suite fires many OTPs from one IP
});

export const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", message: "Too many attempts. Try again later." },
  keyGenerator: keyFromRequest, // BF_SERVER_AUTH_RATE_LIMIT_v2
  skip: () => isTest,
});
