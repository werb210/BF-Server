import type { Request } from "express";

export function rateLimitKeyFromRequest(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];

  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim().replace(/^::ffff:/, "");
  }

  return (req.ip ?? "unknown").replace(/:\d+$/, "").replace(/^::ffff:/, "");
}
