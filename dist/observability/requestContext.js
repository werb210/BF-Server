import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { stripUndefined } from "../utils/clean.js";
const storage = new AsyncLocalStorage();
export function requestContextMiddleware(req, res, next) {
    const requestId = String(req.headers["x-request-id"] ?? randomUUID());
    const store = {
        requestId,
        route: req.originalUrl,
        dbProcessIds: [],
    };
    req.id = requestId;
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    storage.run(store, next);
}
export function fetchRequestContext() {
    return storage.getStore();
}
export function fetchRequestId() {
    return storage.getStore()?.requestId ?? "unknown";
}
export function fetchRequestRoute() {
    return storage.getStore()?.route ?? "";
}
export function fetchRequestIdempotencyKeyHash() {
    return storage.getStore()?.idempotencyKeyHash ?? "";
}
export function fetchRequestDbProcessIds() {
    return storage.getStore()?.dbProcessIds ?? [];
}
export function runWithRequestContext(fn, context) {
    const base = stripUndefined({
        requestId: context?.requestId ?? randomUUID(),
        route: context?.route,
        idempotencyKeyHash: context?.idempotencyKeyHash,
        dbProcessIds: context?.dbProcessIds ?? [],
    });
    return storage.run(base, fn);
}
