import * as appInsights from "applicationinsights";
import { config } from "../config/index.js";
import { logInfo, logWarn } from "./logger.js";
let telemetryClient = null;
let initialized = false;
function isValidConnectionString(connectionString) {
    const match = connectionString.match(/InstrumentationKey=([0-9a-fA-F-]{36})/);
    if (!match || !match[1]) {
        return false;
    }
    const guidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    return guidPattern.test(match[1]);
}
export function initializeAppInsights() {
    if (initialized) {
        return;
    }
    initialized = true;
    try {
        const connectionString = config.telemetry.appInsightsConnectionString;
        if (!connectionString?.trim()) {
            logWarn("appinsights_disabled", {
                reason: "missing_connection_string",
                testEnvironment: config.env === "test",
            });
            return;
        }
        if (!isValidConnectionString(connectionString)) {
            logWarn("appinsights_disabled", {
                reason: "invalid_connection_string",
            });
            telemetryClient = null;
            return;
        }
        if (typeof appInsights.setup !== "function") {
            logWarn("appinsights_disabled", {
                reason: "setup_unavailable",
            });
            return;
        }
        appInsights
            .setup(connectionString)
            .setAutoCollectConsole(false, false)
            .setAutoCollectExceptions(true)
            .setAutoCollectPerformance(false, false)
            .setAutoCollectRequests(true)
            .setAutoCollectDependencies(true)
            .setSendLiveMetrics(false)
            .start();
        telemetryClient =
            appInsights.defaultClient ?? null;
        logInfo("appinsights_initialized");
    }
    catch (error) {
        logWarn("appinsights_disabled", {
            reason: "initialization_failed",
            error,
        });
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
