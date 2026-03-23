import { randomUUID } from "crypto";
import { type NextFunction, type Request, type Response } from "express";
import { config } from "@/config";

const IDEMPOTENCY_HEADER = "idempotency-key";
const enforceMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hasBearerToken(req: Request): boolean {
  const authorization = req.get("authorization") ?? "";
  return authorization.toLowerCase().startsWith("bearer ");
}

export function ensureIdempotencyKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!config.flags.idempotencyEnabled) {
    next();
    return;
  }
  if (!enforceMethods.has(req.method.toUpperCase())) {
    next();
    return;
  }

  if (!hasBearerToken(req)) {
    next();
    return;
  }

  const existing = req.get(IDEMPOTENCY_HEADER);
  if (existing && existing.trim().length > 0) {
    next();
    return;
  }

  req.headers[IDEMPOTENCY_HEADER] = randomUUID();
  res.locals.idempotencyKeyGenerated = true;
  next();
}
