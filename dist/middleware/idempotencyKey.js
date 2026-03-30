"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureIdempotencyKey = ensureIdempotencyKey;
const crypto_1 = require("crypto");
const config_1 = require("../config");
const IDEMPOTENCY_HEADER = "idempotency-key";
const enforceMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function hasBearerToken(req) {
    const authorization = req.get("authorization") ?? "";
    return authorization.toLowerCase().startsWith("bearer ");
}
function ensureIdempotencyKey(req, res, next) {
    if (!config_1.config.flags.idempotencyEnabled) {
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
    req.headers[IDEMPOTENCY_HEADER] = (0, crypto_1.randomUUID)();
    res.locals.idempotencyKeyGenerated = true;
    next();
}
