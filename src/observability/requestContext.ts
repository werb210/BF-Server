import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import { type NextFunction, type Request, type Response } from "express";

export type RequestContextStore = {
  requestId: string;
  method: string;
  path: string;
  startTime: number;
  sqlTraceEnabled: boolean;
  dbProcessIds?: Set<number>;
  idempotencyKeyHash?: string;
};

export type RequestContextInput = {
  requestId: string;
  method?: string;
  path?: string;
  startTime?: number;
  sqlTraceEnabled?: boolean;
  dbProcessIds?: Set<number>;
  idempotencyKeyHash?: string;
};

const storage = new AsyncLocalStorage<RequestContextStore>();

const isSqlTracePath = (path: string): boolean =>
  path.startsWith("/api/lenders") || path.startsWith("/api/lender-products");

const resolveRequestId = (req: Request): string => {
  if (typeof req.id === "string" && req.id.trim().length > 0) {
    return req.id;
  }
  const headerValue = req.get("x-request-id");
  const trimmed = headerValue ? headerValue.trim() : "";
  return trimmed.length > 0 ? trimmed : randomUUID();
};

const buildStore = (input: RequestContextInput): RequestContextStore => {
  const path = input.path ?? "unknown";
  const store: RequestContextStore = {
    requestId: input.requestId,
    method: input.method ?? "UNKNOWN",
    path,
    startTime: input.startTime ?? Date.now(),
    sqlTraceEnabled: input.sqlTraceEnabled ?? isSqlTracePath(path),
    dbProcessIds: input.dbProcessIds ?? new Set<number>(),
  };
  if (input.idempotencyKeyHash !== undefined) {
    store.idempotencyKeyHash = input.idempotencyKeyHash;
  }
  return store;
};

export function getRequestContext(): RequestContextStore | undefined {
  return storage.getStore();
}

export function runWithRequestContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId = resolveRequestId(req);
  const store = buildStore({
    requestId,
    method: req.method,
    path: req.path,
    startTime: Date.now(),
  });

  storage.run(store, () => {
    res.locals.requestId = requestId;
    res.locals.requestStart = store.startTime;
    res.locals.requestPath = store.path;
    res.setHeader("X-Request-Id", requestId);
    next();
  });
}

export function withRequestContext<T>(
  ctx: RequestContextInput,
  fn: () => T
): T {
  const previous = storage.getStore();
  const store = buildStore(ctx);

  const restore = (): void => {
    if (previous) {
      storage.enterWith(previous);
    }
  };

  const result = storage.run(store, fn);

  if (result instanceof Promise) {
    return result.finally(restore) as T;
  }

  restore();
  return result;
}
