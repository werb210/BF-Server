import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { type NextFunction, type Request, type Response } from "express";

type RequestContextStore = {
  requestId: string;
  route?: string;
  idempotencyKeyHash?: string;
  dbProcessIds: string[];
};

const storage = new AsyncLocalStorage<RequestContextStore>();

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = String(req.headers["x-request-id"] ?? randomUUID());
  const store: RequestContextStore = {
    requestId,
    route: req.originalUrl,
    dbProcessIds: [],
  };

  req.id = requestId;
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  storage.run(store, next);
}

export function fetchRequestContext(): RequestContextStore | undefined {
  return storage.getStore();
}

export function fetchRequestId(): string {
  return storage.getStore()?.requestId ?? "unknown";
}

export function fetchRequestRoute(): string {
  return storage.getStore()?.route ?? "";
}

export function fetchRequestIdempotencyKeyHash(): string {
  return storage.getStore()?.idempotencyKeyHash ?? "";
}

export function fetchRequestDbProcessIds(): string[] {
  return storage.getStore()?.dbProcessIds ?? [];
}

export function runWithRequestContext<T>(fn: () => Promise<T>, context?: Partial<RequestContextStore>): Promise<T> {
  const base: RequestContextStore = {
    requestId: context?.requestId ?? randomUUID(),
    route: context?.route,
    idempotencyKeyHash: context?.idempotencyKeyHash,
    dbProcessIds: context?.dbProcessIds ?? [],
  };
  return storage.run(base, fn);
}
