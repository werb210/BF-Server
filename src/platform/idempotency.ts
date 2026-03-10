import { type NextFunction, type Request, type Response } from "express";

const requests = new Map<string, true>();
const ENFORCED_METHODS = new Set(["POST", "PATCH", "DELETE"]);

export function idempotency(req: Request, res: Response, next: NextFunction): Response | void {
  if (!ENFORCED_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  const key = req.headers["idempotency-key"];
  const normalizedKey = typeof key === "string" ? key.trim() : "";

  if (!normalizedKey) {
    next();
    return;
  }

  if (requests.has(normalizedKey)) {
    return res.status(409).json({
      success: false,
      error: "Duplicate request",
    });
  }

  requests.set(normalizedKey, true);

  setTimeout(() => {
    requests.delete(normalizedKey);
  }, 3_600_000);

  next();
}
