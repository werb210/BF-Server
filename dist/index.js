"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
const db_1 = require("./db");
const deadLetterWorker_1 = require("./workers/deadLetterWorker");
const verifyCheck_1 = require("./startup/verifyCheck");
process.on("unhandledRejection", (err) => {
    console.error("[UNHANDLED REJECTION]", err);
});
process.on("uncaughtException", (err) => {
    console.error("[UNCAUGHT EXCEPTION]", err);
});
async function start() {
    console.log("[BOOT] Starting server...");
    if (process.env.NODE_ENV !== "test") {
        await (0, db_1.ensureDb)();
    }
    await (0, verifyCheck_1.verifyTwilioSetup)();
    setInterval(() => {
        (0, deadLetterWorker_1.processDeadLetters)().catch((err) => console.error("Dead letter worker failed", err));
    }, 15000);
    const PORT = Number(process.env.PORT || 8080);
    app_1.default.listen(PORT, "0.0.0.0", () => {
        console.log(`[BOOT] Server listening on ${PORT}`);
    });
}
start().catch((err) => {
    console.error("UNHANDLED_STARTUP_ERROR", err);
    process.exit(1);
});
