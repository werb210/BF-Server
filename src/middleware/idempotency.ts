import { type NextFunction, type Request, type Response } from "express";
import { getIdempotent, setIdempotent } from "../platform/idempotencyRedis";
import { hashRequest } from "../utils/hash";
import { logInfo, logWarn } from "../observability/logger";
import { config } from "../config";

const IDEMPOTENCY_HEADER = "idempotency-key";
const ENFORCED_METHODS = new Set(["POST", "PATCH", "DELETE"]);
const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9-_]{10,}$/;

function duplicateBody(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return {
      ...(body as Record<string, unknown>),
      status: "duplicate",
    };
  }

  return { data: body, status: "duplicate" };
}

function buildRedisKey(req: Request, key: string): string {
  return `idemp:${req.path}:${key}`;
}

export async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!ENFORCED_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  if (config.env === "test") {
    next();
    return;
  }

  const key = req.get(IDEMPOTENCY_HEADER)?.trim();
  if (!key) {
    next();
    return;
  }

  if (!IDEMPOTENCY_KEY_REGEX.test(key)) {
    res.status(400).json({ error: "Invalid idempotency key" });
    return;
  }

  const redisKey = buildRedisKey(req, key);
  const requestHash = hashRequest(req.body);

  try {
    const existing = await getIdempotent(redisKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        res.status(409).json({
          code: "idempotency_conflict",
          message: "Idempotency key reused with a different request payload.",
        });
        return;
      }

      logInfo("idempotent_request_replayed", { key, route: req.path });
      res.status(200).json(duplicateBody(existing.response));
      return;
    }
  } catch (error: unknown) {
    logWarn("idempotency_redis_read_failed", {
      key,
      route: req.path,
      error: error instanceof Error ? error.message : "redis_read_failed",
    });
  }

  const originalJson = res.json.bind(res) as (body: unknown) => Response;
  res.json = ((body: unknown): Response => {
    if (res.statusCode < 500) {
      void setIdempotent(redisKey, {
        requestHash,
        response: body,
      }).catch((error: unknown) => {
        logWarn("idempotency_store_failed", {
          key,
          route: req.path,
          error: error instanceof Error ? error.message : "store_failed",
        });
      });

      logInfo("idempotent_request_recorded", { key, route: req.path });
    }

    return originalJson(body);
  }) as Response["json"];

  next();
}
