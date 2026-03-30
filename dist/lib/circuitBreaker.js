"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canExecute = canExecute;
exports.recordFailure = recordFailure;
exports.safeCall = safeCall;
let failureCount = 0;
let lastFailureTime = 0;
const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT = 30000; // 30s
function canExecute() {
    if (failureCount < FAILURE_THRESHOLD)
        return true;
    const now = Date.now();
    if (now - lastFailureTime > RESET_TIMEOUT) {
        failureCount = 0;
        return true;
    }
    return false;
}
function recordFailure() {
    failureCount++;
    lastFailureTime = Date.now();
}
async function safeCall(fn) {
    if (!canExecute()) {
        throw new Error("Service unavailable");
    }
    try {
        const result = await fn();
        failureCount = 0;
        return result;
    }
    catch (err) {
        recordFailure();
        throw err;
    }
}
