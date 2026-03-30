"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireIdempotency = requireIdempotency;
const store = new Map();
const MAX_STORE_SIZE = 1000;
const STORE_TTL_MS = 10 * 60 * 1000;
function setWithTTL(key, value, ttlMs = STORE_TTL_MS) {
    store.set(key, value);
    setTimeout(() => store.delete(key), ttlMs).unref();
    if (store.size > MAX_STORE_SIZE) {
        const firstKey = store.keys().next().value;
        if (firstKey) {
            store.delete(firstKey);
        }
    }
}
function requireIdempotency(req, res, next) {
    const key = req.headers["idempotency-key"];
    if (!key) {
        return res.status(400).json({ error: "Missing Idempotency-Key" });
    }
    if (store.has(key)) {
        return res["json"](store.get(key));
    }
    const originalJson = res["json"].bind(res);
    res["json"] = (body) => {
        setWithTTL(String(key), body);
        return originalJson(body);
    };
    next();
}
