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
import { isIP } from "node:net";

// BF_SERVER_v789_XFF_RIGHTMOST - the left-most x-forwarded-for entry is whatever
// the caller sent; only the entries appended by our own proxies can be trusted.
// Walk from the right and take the first public address (same rule as
// authRateLimit.ts), so a spoofed left-most entry cannot change the key.
function normalise(raw: string): string {
  const withoutV4Mapped = raw.trim().replace(/^::ffff:/i, "");
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(withoutV4Mapped)) return withoutV4Mapped.split(":")[0];
  const bracketed = withoutV4Mapped.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  return withoutV4Mapped;
}

function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

export function clientIpFromRequest(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const joined = Array.isArray(forwarded) ? forwarded.join(",") : typeof forwarded === "string" ? forwarded : "";
  const hops = joined.split(",").map(normalise).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (isIP(hops[i]) && !isPrivate(hops[i])) return hops[i];
  }
  const rawIp = hops[hops.length - 1] || ((req as { ip?: string }).ip ?? "unknown");

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
