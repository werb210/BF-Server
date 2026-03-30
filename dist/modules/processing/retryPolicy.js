"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_RETRY_POLICY = void 0;
exports.computeRetryDelayMs = computeRetryDelayMs;
exports.assertRetryAllowed = assertRetryAllowed;
const errors_1 = require("../../middleware/errors");
exports.DEFAULT_RETRY_POLICY = {
    maxRetries: 1,
    baseDelayMs: 30000,
};
function computeRetryDelayMs(retryCount, baseDelayMs) {
    return baseDelayMs * 2 ** Math.max(0, retryCount);
}
function assertRetryAllowed(params) {
    if (params.retryCount >= params.maxRetries) {
        throw new errors_1.AppError("retry_exhausted", "Max retries reached.", 409);
    }
    const delay = computeRetryDelayMs(params.retryCount, params.baseDelayMs);
    if (!params.lastRetryAt) {
        return delay;
    }
    const elapsed = Date.now() - params.lastRetryAt.getTime();
    if (elapsed < delay) {
        throw new errors_1.AppError("retry_backoff", "Retry backoff window has not elapsed.", 429);
    }
    return delay;
}
