"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installProcessHandlers = installProcessHandlers;
const logger_1 = require("./logger");
const appInsights_1 = require("./appInsights");
const dbRuntime_1 = require("../dbRuntime");
let handlersInstalled = false;
function installProcessHandlers() {
    if (handlersInstalled) {
        return;
    }
    handlersInstalled = true;
    process.on("unhandledRejection", (reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        (0, logger_1.logError)("unhandled_rejection", { error: error.message });
        const classification = (0, dbRuntime_1.isDbConnectionFailure)(error)
            ? "db_unavailable"
            : "unknown";
        (0, appInsights_1.trackException)({
            exception: error,
            properties: {
                event: "unhandled_rejection",
                classification,
            },
        });
    });
}
