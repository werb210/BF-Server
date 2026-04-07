"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const app_1 = require("../app");
const deps_1 = require("../system/deps");
/**
 * Canonical server factory — NO ARGS
 */
function createServer() {
    (0, app_1.resetOtpStateForTests)();
    deps_1.globalState.metrics.requests = 0;
    deps_1.globalState.metrics.errors = 0;
    deps_1.globalState.rateLimit.window = 0;
    deps_1.globalState.rateLimit.count = 0;
    return (0, app_1.createApp)({ includeResponseRid: false });
}
exports.default = createServer;
