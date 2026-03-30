"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestContextMiddleware = requestContextMiddleware;
exports.fetchRequestContext = fetchRequestContext;
exports.fetchRequestId = fetchRequestId;
exports.fetchRequestRoute = fetchRequestRoute;
exports.fetchRequestIdempotencyKeyHash = fetchRequestIdempotencyKeyHash;
exports.fetchRequestDbProcessIds = fetchRequestDbProcessIds;
exports.runWithRequestContext = runWithRequestContext;
const node_async_hooks_1 = require("node:async_hooks");
const node_crypto_1 = require("node:crypto");
const storage = new node_async_hooks_1.AsyncLocalStorage();
function requestContextMiddleware(req, res, next) {
    const requestId = String(req.headers["x-request-id"] ?? (0, node_crypto_1.randomUUID)());
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
function fetchRequestContext() {
    return storage.getStore();
}
function fetchRequestId() {
    return storage.getStore()?.requestId ?? "unknown";
}
function fetchRequestRoute() {
    return storage.getStore()?.route ?? "";
}
function fetchRequestIdempotencyKeyHash() {
    return storage.getStore()?.idempotencyKeyHash ?? "";
}
function fetchRequestDbProcessIds() {
    return storage.getStore()?.dbProcessIds ?? [];
}
function runWithRequestContext(fn, context) {
    const base = {
        requestId: context?.requestId ?? (0, node_crypto_1.randomUUID)(),
        route: context?.route,
        idempotencyKeyHash: context?.idempotencyKeyHash,
        dbProcessIds: context?.dbProcessIds ?? [],
    };
    return storage.run(base, fn);
}
