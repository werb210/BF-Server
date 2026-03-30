"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchCircuitBreaker = fetchCircuitBreaker;
exports.resetCircuitBreakers = resetCircuitBreakers;
exports.canProceed = canProceed;
exports.recordFailure = recordFailure;
exports.recordSuccess = recordSuccess;
exports.circuitGuard = circuitGuard;
exports.resetCircuit = resetCircuit;
const breakers = new Map();
class CircuitBreaker {
    options;
    failures = 0;
    state = "CLOSED";
    openedAt = null;
    constructor(options) {
        this.options = options;
    }
    fetchSnapshot() {
        return {
            state: this.state,
            failures: this.failures,
            openedAt: this.openedAt,
        };
    }
    canRequest(now = Date.now()) {
        if (this.state === "OPEN") {
            if (this.openedAt !== null && now - this.openedAt >= this.options.cooldownMs) {
                this.state = "HALF_OPEN";
                return true;
            }
            return false;
        }
        return true;
    }
    recordSuccess() {
        this.failures = 0;
        this.state = "CLOSED";
        this.openedAt = null;
    }
    recordFailure(now = Date.now()) {
        if (this.state === "HALF_OPEN") {
            this.state = "OPEN";
            this.openedAt = now;
            this.failures = this.options.failureThreshold;
            return;
        }
        this.failures += 1;
        if (this.failures >= this.options.failureThreshold) {
            this.state = "OPEN";
            this.openedAt = now;
        }
    }
}
function fetchCircuitBreaker(name, options) {
    const existing = breakers.get(name);
    if (existing) {
        return existing;
    }
    const breaker = new CircuitBreaker(options);
    breakers.set(name, breaker);
    return breaker;
}
function resetCircuitBreakers() {
    breakers.clear();
}
let globalFailureCount = 0;
let globalBlockedUntil = 0;
function canProceed() {
    if (Date.now() < globalBlockedUntil)
        return false;
    return true;
}
function recordFailure() {
    globalFailureCount += 1;
    if (globalFailureCount > 5) {
        globalBlockedUntil = Date.now() + 60_000;
    }
}
function recordSuccess() {
    globalFailureCount = 0;
    globalBlockedUntil = 0;
}
function circuitGuard() {
    const now = Date.now();
    if (globalFailureCount > 5 && now - (globalBlockedUntil - 60_000) < 30_000 && now < globalBlockedUntil) {
        throw new Error("AI temporarily disabled due to repeated failures.");
    }
    if (!canProceed()) {
        throw new Error("AI temporarily disabled due to repeated failures.");
    }
}
function resetCircuit() {
    recordSuccess();
}
