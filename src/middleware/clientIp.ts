// BF_SERVER_AZURE_XFF_PORT_v183
// Azure App Service writes x-forwarded-for as "<ip>:<port>", not a bare address.
// This function stripped the port only on the req.ip fallback, which Azure never
// reaches because the header is always present. So every limiter keyed on this
// helper was keying on an ephemeral source port that changes per connection:
// the five limiters using it (Maya capital, Maya chat, both in rateLimiter.ts,
// and publicLimiter) have never rate-limited anything in production, silently.
//
// safeKeyGenerator in middleware/rateLimit.ts already handled this; this brings
// the helper to the same behaviour, including the ipKeyGenerator call that
// collapses IPv6 to its /64 prefix so a single host cannot rotate addresses
// within its own allocation to reset a limit.
import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";

export function clientIpFromRequest(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const rawIp = typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : ((req as { ip?: string }).ip ?? "unknown");

  const withoutV4Mapped = rawIp.replace(/^::ffff:/, "");
  // Only an IPv4 address can be split on ":" - a bare IPv6 address is full of
  // them, and "[::1]:443" is handled by the bracketed form below.
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(withoutV4Mapped)) return withoutV4Mapped.split(":")[0];
  const bracketed = withoutV4Mapped.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  return withoutV4Mapped || rawIp;
}

export function rateLimitKeyFromRequest(req: Request): string {
  return ipKeyGenerator(clientIpFromRequest(req));
}
