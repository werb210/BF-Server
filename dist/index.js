"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("./system/errors");
const app_1 = __importDefault(require("./app"));
const deadLetterWorker_1 = require("./workers/deadLetterWorker");
const verifyCheck_1 = require("./startup/verifyCheck");
const init_1 = require("./system/init");
const shutdown_1 = require("./system/shutdown");
const env_1 = require("./system/env");
(0, env_1.validateEnv)();
async function start() {
    console.log("[BOOT] Starting server...");
    await (0, verifyCheck_1.verifyTwilioSetup)();
    setInterval(() => {
        (0, deadLetterWorker_1.processDeadLetters)().catch((err) => console.error("Dead letter worker failed", err));
    }, 15000);
    const PORT = Number(process.env.PORT);
    const server = app_1.default.listen(PORT, "0.0.0.0", () => {
        console.log(`[BOOT] Server listening on ${PORT}`);
        console.log("[BOOT] Server running");
    });
    (0, shutdown_1.setupShutdown)(server);
    void (0, init_1.initDependencies)();
}
start().catch((err) => {
    console.error("UNHANDLED_STARTUP_ERROR", err);
});
