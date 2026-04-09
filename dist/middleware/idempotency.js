import { fetchStoredResponse, storeResponse } from "../lib/idempotencyStore.js";
import { hashRequest } from "../utils/hash.js";
const IDEMPOTENCY_HEADER = "idempotency-key";
const ENFORCED_METHODS = new Set(["POST", "PATCH", "DELETE"]);
const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9-_]{10,}$/;
function duplicateBody(body) {
    if (body && typeof body === "object" && !Array.isArray(body)) {
        return {
            ...body,
            status: "duplicate",
        };
    }
    return { data: body, status: "duplicate" };
}
function buildStorageKey(req, key) {
    const userId = req.user?.id || "anon";
    return `idemp:${userId}:${req.path}:${key}`;
}
export async function idempotencyMiddleware(req, res, next) {
    if (!ENFORCED_METHODS.has(req.method.toUpperCase())) {
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
    const storageKey = buildStorageKey(req, key);
    const requestHash = hashRequest(req.body);
    const existing = await fetchStoredResponse(storageKey);
    if (existing) {
        if (existing.requestHash !== requestHash) {
            res.status(409).json({
                code: "idempotency_conflict",
                message: "Idempotency key reused with a different request payload.",
            });
            return;
        }
        res.status(200).json(duplicateBody(existing.body));
        return;
    }
    const originalJson = res["json"].bind(res);
    res["json"] = ((body) => {
        if (res.statusCode < 500) {
            void storeResponse(storageKey, {
                requestHash,
                body,
                statusCode: res.statusCode,
                storedAt: Date.now(),
            });
        }
        return originalJson(body);
    });
    next();
}
