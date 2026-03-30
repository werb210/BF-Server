"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTelemetryProperties = buildTelemetryProperties;
const config_1 = require("../config");
const requestContext_1 = require("../observability/requestContext");
const instanceId = config_1.config.telemetry.instanceId;
function buildTelemetryProperties(properties, route) {
    const resolvedRoute = route ??
        (typeof properties?.route === "string" ? properties.route : undefined) ??
        (0, requestContext_1.fetchRequestRoute)();
    const merged = {
        ...properties,
        instanceId,
        buildId: config_1.config.commitSha,
    };
    if (resolvedRoute) {
        merged.route = resolvedRoute;
    }
    return merged;
}
