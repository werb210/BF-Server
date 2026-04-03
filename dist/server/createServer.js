"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const app_1 = require("../app");
/**
 * Canonical server factory — NO ARGS
 */
function createServer() {
    (0, app_1.resetOtpStateForTests)();
    return (0, app_1.createApp)();
}
exports.default = createServer;
