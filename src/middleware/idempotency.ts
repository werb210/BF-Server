// src/middleware/idempotency.ts

import { type NextFunction, type Request, type Response } from "express";
import { createHash } from "crypto";
import { pool } from "../db";
import { isDbConnectionFailure, isTestEnvironment } from "../dbRuntime";
import { AppError } from "./errors";
import { getIdempotencyEnabled, isProductionEnvironment } from "../config";
import {
  createIdempotencyRecord,
  deleteExpiredIdempotencyRecord,
  findIdempotencyRecord,
  purgeExpiredIdempotencyKeys,
} from "../modules/idempotency/idempotency.repo";
import { logWarn } from "../observability/logger";
import { trackEvent } from "../observability/appInsights";
import { setRequestIdempotencyKeyHash } from "./requestContext";

const IDEMPOTENCY_HEADER = "idempotency-key";
const ENFORCED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function advisoryLockKey(value: string): [number, number] {
  const hash = createHash("sha256").update(value).digest();
  return [hash.readInt32BE(0), hash.readInt32BE(4)];
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",")}}`;
}

function isAuthRoute(req: Request): boolean {
  const path = (req.originalUrl ?? req.url ?? "").split("?")[0] ?? "";
  return path.startsWith("/api/auth/");
}

function isIdempotencyExempt(req: Request): boolean {
  return (
    req.path === "/webhooks/twilio/voice"
  );
}

function isOptionalIdempotencyRoute(req: Request): boolean {
  if (req.path === "/client/submissions") {
    return true;
  }
  if (req.path === "/client/documents" || req.path.startsWith("/client/documents/")) {
    return true;
  }
  return false;
}

function normalizeRouteScope(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

function shouldBypass(error: unknown): boolean {
  if (isDbConnectionFailure(error)) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  return code === "42P01" || code === "42703" || code === "42P07";
}

export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!getIdempotencyEnabled()) return next();
  if (isAuthRoute(req)) return next();
  if (isIdempotencyExempt(req)) return next();
  if (!ENFORCED_METHODS.has(req.method)) return next();

  const rawKey = req.get(IDEMPOTENCY_HEADER)?.trim();
  if (!rawKey) {
    if (isOptionalIdempotencyRoute(req)) {
      return next();
    }
    if (!isProductionEnvironment()) {
      logWarn("idempotency_key_missing", {
        route: req.originalUrl,
        requestId: res.locals.requestId ?? "unknown",
      });
    }
    return next(
      new AppError(
        "missing_idempotency_key",
        "Idempotency-Key header is required.",
        400
      )
    );
  }

  if (rawKey.length > 128) {
    return next(
      new AppError(
        "idempotency_key_too_long",
        "Idempotency-Key is too long.",
        400
      )
    );
  }

  const requestId = res.locals.requestId ?? "unknown";
  const requestPath = (req.originalUrl ?? req.url ?? req.path).split("?")[0] ?? req.path;
  const route = normalizeRouteScope(requestPath.startsWith("/api/") ? requestPath.slice(4) : requestPath);
  const requestHash = sha256(stableStringify(req.body ?? {}));
  const keyHash = sha256(rawKey);

  setRequestIdempotencyKeyHash(keyHash);

  if (isTestEnvironment() && req.get("authorization")) {
    return next();
  }

  const lockKey = advisoryLockKey(`${route}:${rawKey}`);
  const shouldLock = !isTestEnvironment();

  (async () => {
    try {
      const client = await pool.connect();
      try {
        if (shouldLock) {
          await client.query("select pg_advisory_lock($1,$2)", lockKey);
        }

        await purgeExpiredIdempotencyKeys(client);

        const existing = await findIdempotencyRecord({
          route,
          idempotencyKey: rawKey,
          client,
        });

        if (existing) {
          if (existing.request_hash !== requestHash) {
            trackEvent({
              name: "idempotency_conflict",
              properties: { route, requestId, idempotencyKeyHash: keyHash },
            });
            res.status(409).json({
              code: "idempotency_conflict",
              message: "Idempotency key reused with different payload.",
              requestId,
            });
            return;
          }

          trackEvent({
            name: "idempotency_cache_hit",
            properties: { route, requestId, idempotencyKeyHash: keyHash },
          });

          res.status(existing.response_code).json(existing.response_body);
          return;
        }

        await deleteExpiredIdempotencyRecord({
          route,
          idempotencyKey: rawKey,
          client,
        });

        const wrap = <T extends (...args: any[]) => any>(fn: T): T =>
          ((body: unknown) => {
            if (!res.headersSent && !res.locals.requestTimedOut) {
              res.locals.idempotencyResponseBody = body;
            }
            return fn(body);
          }) as T;

        res.json = wrap(res.json.bind(res));
        res.send = wrap(res.send.bind(res));

        next();

        await new Promise<void>((resolve) => {
          res.on("finish", resolve);
          res.on("close", resolve);
        });

        if (res.statusCode < 500 && !res.locals.requestTimedOut) {
          await createIdempotencyRecord({
            idempotencyKey: rawKey,
            route,
            method: req.method,
            requestHash,
            responseCode: res.statusCode,
            responseBody: res.locals.idempotencyResponseBody ?? null,
            client,
          });
        }
      } finally {
        if (shouldLock) {
          try {
            await client.query("select pg_advisory_unlock($1,$2)", lockKey);
          } catch {}
        }
        client.release();
      }
    } catch (err) {
            logWarn("idempotency_failed", {
        requestId,
        route,
        error: err instanceof Error ? err.message : "unknown_error",
      });

      if (!res.headersSent) {
        if (shouldBypass(err)) {
          next();
          return;
        }
        next(err instanceof Error ? err : new Error("idempotency_failed"));
      }
    }
  })();
}

export function hashIdempotencyKey(
  key: string | null | undefined
): string {
  return sha256(key ?? "missing");
}
