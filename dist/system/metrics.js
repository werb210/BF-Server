import { deps } from "./deps.js";
export function trackRequest() {
    deps.metrics.requests++;
}
export function trackError() {
    deps.metrics.errors++;
}
export function getMetrics() {
    return {
        requests: deps.metrics.requests,
        errors: deps.metrics.errors,
    };
}
export function resetMetrics() {
    deps.metrics.requests = 0;
    deps.metrics.errors = 0;
}
export const incReq = trackRequest;
export const incErr = trackError;
export const metrics = getMetrics;
