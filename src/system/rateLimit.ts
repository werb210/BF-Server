import { type NextFunction, type Request, type Response } from "express";
import { CONFIG } from "./config";

type RateEntry = {
  count: number;
  ts: number;
};

const hits = new Map<string, RateEntry>();

export function resetRateLimitForTests() {
  hits.clear();
}

export function rateLimit() {
  const limit = CONFIG.RATE_LIMIT;
  const windowMs = CONFIG.RATE_WINDOW_MS;

  return (req: Request, res: Response, next: NextFunction) => {
    const raw =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      req.ip ||
      "unknown";

    const key: string = raw || "unknown";
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, ts: now };

    if (now - entry.ts > windowMs) {
      entry.count = 0;
      entry.ts = now;
    }

    entry.count += 1;
    hits.set(key, entry);

    if (entry.count > limit) {
      return res.status(429).json({ status: "error", error: "RATE_LIMIT" });
    }

    return next();
  };
}
