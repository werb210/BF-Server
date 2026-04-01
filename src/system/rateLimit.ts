import { type NextFunction, type Request, type Response } from "express";

type RateEntry = {
  count: number;
  ts: number;
};

const hits = new Map<string, RateEntry>();

export function resetRateLimitForTests() {
  hits.clear();
}

export function rateLimit(limit = 100, windowMs = 60_000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      req.ip ||
      "unknown";
    const safeKey: string = key || "unknown";
    const now = Date.now();
    const entry = hits.get(safeKey) || { count: 0, ts: now };

    if (now - entry.ts > windowMs) {
      entry.count = 0;
      entry.ts = now;
    }

    entry.count += 1;
    hits.set(safeKey, entry);

    if (entry.count > limit) {
      return res.status(429).json({ status: "error", error: "RATE_LIMIT" });
    }

    return next();
  };
}
