"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metrics = exports.incErr = exports.incReq = void 0;
exports.trackRequest = trackRequest;
exports.trackError = trackError;
exports.getMetrics = getMetrics;
exports.resetMetrics = resetMetrics;
const deps_1 = require("./deps");
function trackRequest() {
    deps_1.deps.metrics.requests++;
}
function trackError() {
    deps_1.deps.metrics.errors++;
}
function getMetrics() {
    return {
        requests: deps_1.deps.metrics.requests,
        errors: deps_1.deps.metrics.errors,
    };
}
function resetMetrics() {
    deps_1.deps.metrics.requests = 0;
    deps_1.deps.metrics.errors = 0;
}
exports.incReq = trackRequest;
exports.incErr = trackError;
exports.metrics = getMetrics;
