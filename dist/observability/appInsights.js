"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeAppInsights = initializeAppInsights;
exports.trackRequest = trackRequest;
exports.trackDependency = trackDependency;
exports.trackException = trackException;
exports.trackEvent = trackEvent;
const appInsights = __importStar(require("applicationinsights"));
const config_1 = require("../config");
const logger_1 = require("./logger");
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
function initializeAppInsights() {
    if (initialized) {
        return;
    }
    initialized = true;
    try {
        const connectionString = config_1.config.telemetry.appInsightsConnectionString;
        if (!connectionString?.trim()) {
            (0, logger_1.logWarn)("appinsights_disabled", {
                reason: "missing_connection_string",
                testEnvironment: config_1.config.env === "test",
            });
            return;
        }
        if (!isValidConnectionString(connectionString)) {
            (0, logger_1.logWarn)("appinsights_disabled", {
                reason: "invalid_connection_string",
            });
            telemetryClient = null;
            return;
        }
        if (typeof appInsights.setup !== "function") {
            (0, logger_1.logWarn)("appinsights_disabled", {
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
        (0, logger_1.logInfo)("appinsights_initialized");
    }
    catch (error) {
        (0, logger_1.logWarn)("appinsights_disabled", {
            reason: "initialization_failed",
            error,
        });
    }
}
function trackRequest(telemetry) {
    telemetryClient?.trackRequest(telemetry);
}
function trackDependency(telemetry) {
    telemetryClient?.trackDependency(telemetry);
}
function trackException(telemetry) {
    telemetryClient?.trackException(telemetry);
}
function trackEvent(telemetry) {
    telemetryClient?.trackEvent?.(telemetry);
}
