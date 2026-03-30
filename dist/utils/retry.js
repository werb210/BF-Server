"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retry = retry;
exports.withRetry = withRetry;
exports.withTimeout = withTimeout;
exports.withRetryAndTimeout = withRetryAndTimeout;
async function retry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        }
        catch (err) {
            if (i === retries - 1) {
                throw err;
            }
        }
    }
    throw new Error("retry_exhausted");
}
async function withRetry(fn, attempts = 3) {
    return retry(fn, attempts);
}
async function withTimeout(fn, timeoutMs = 10000) {
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new Error(`operation_timed_out_after_${timeoutMs}ms`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([fn(), timeoutPromise]);
    }
    finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}
async function withRetryAndTimeout(fn, retries = 3, timeoutMs = 10000) {
    return withRetry(() => withTimeout(fn, timeoutMs), retries);
}
