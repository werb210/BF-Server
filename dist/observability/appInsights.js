import { config } from "../config/index.js";
import { logInfo, logWarn } from "./logger.js";
let appInsights = null;
let telemetryClient = null;
let initialized = false;
export function initAppInsights() {
    const key = config.telemetry.appInsightsConnectionString;
    if (!key?.trim()) {
        logWarn("appinsights_disabled", {
            reason: "missing_connection_string",
            testEnvironment: config.env === "test",
        });
        return;
    }
    try {
        const mod = requireSafe("applicationinsights");
        if (!mod) {
            logWarn("appinsights_disabled", {
                reason: "package_missing",
            });
            return;
        }
        appInsights = mod;
        appInsights
            .setup(key)
            .setAutoCollectRequests(true)
            .setAutoCollectPerformance(true)
            .setAutoCollectExceptions(true)
            .start();
        telemetryClient = appInsights.defaultClient ?? null;
        logInfo("appinsights_initialized");
    }
    catch (error) {
        logWarn("appinsights_disabled", {
            reason: "initialization_failed",
            error,
        });
    }
}
export function initializeAppInsights() {
    if (initialized) {
        return;
    }
    initialized = true;
    initAppInsights();
}
function requireSafe(pkg) {
    try {
        return eval("require")(pkg);
    }
    catch {
        return null;
    }
}
export function trackRequest(telemetry) {
    telemetryClient?.trackRequest(telemetry);
}
export function trackDependency(telemetry) {
    telemetryClient?.trackDependency(telemetry);
}
export function trackException(telemetry) {
    telemetryClient?.trackException(telemetry);
}
export function trackEvent(telemetry) {
    telemetryClient?.trackEvent?.(telemetry);
}
