import { createHash } from "crypto";
import { type NextFunction, type Request, type Response } from "express";
import { fetchStoredResponse, storeResponse } from "../lib/idempotencyStore";
import { logInfo, logWarn } from "../observability/logger";

const ENFORCED_METHODS = new Set(["POST", "PATCH", "DELETE"]);
const inFlightRequests = new Map<string, Promise<void>>();

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  return `{${sortedKeys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function requestHash(req: Request): string {
  const payload = `${req.method}:${req.path}:${stableStringify(req.body ?? {})}`;
  return createHash("sha256").update(payload).digest("hex");
}

function normalizePath(req: Request): string {
  const rawPath = (req.originalUrl ?? req.path).split("?")[0] ?? req.path;
  return rawPath.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
    ":id"
  );
}

function buildStoreKey(req: Request, key: string): string {
  return `${req.method}:${normalizePath(req)}:${key}`;
}

function allowReplayOnHashMismatch(req: Request): boolean {
  const path = normalizePath(req);
  return path === "/api/client/submissions" || path === "/api/client/documents";
}

export async function idempotency(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!ENFORCED_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  const key = req.get("idempotency-key")?.trim();
  if (!key) {
    next();
    return;
  }

  const storeKey = buildStoreKey(req, key);
  const hash = requestHash(req);

  const existingInFlight = inFlightRequests.get(storeKey);
  if (existingInFlight) {
    await existingInFlight;
    const replay = await fetchStoredResponse(storeKey);
    if (replay) {
      logInfo("idempotent_request_replayed", { key, route: req.path });
      res.status(replay.statusCode).json(replay.body);
      return;
    }
  }

  const cached = await fetchStoredResponse(storeKey);
  if (cached) {
    if (cached.requestHash !== hash) {
      if (!allowReplayOnHashMismatch(req)) {
        res.status(409).json({
          code: "idempotency_conflict",
          message: "Idempotency key reused with a different request payload.",
        });
        return;
      }

      logWarn("idempotency_hash_mismatch_replayed", {
        key,
        route: req.path,
      });
    }

    logInfo("idempotent_request_replayed", { key, route: req.path });
    res.status(cached.statusCode).json(cached.body);
    return;
  }

  const finalize = new Promise<void>((resolve) => {
    res.on("finish", resolve);
    res.on("close", resolve);
  });
  inFlightRequests.set(storeKey, finalize);

  const originalJson = res.json.bind(res) as (body: unknown) => Response;
  res.json = ((body: unknown): Response => {
    if (res.statusCode < 500) {
      void storeResponse(storeKey, {
        statusCode: res.statusCode,
        body,
        requestHash: hash,
        storedAt: Date.now(),
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

  finalize.finally(() => {
    inFlightRequests.delete(storeKey);
  });

  next();
}
