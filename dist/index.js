"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
const env_1 = require("./config/env");
const init_1 = require("./db/init");
const ioredis_1 = __importDefault(require("ioredis"));
console.log("=== BOOT START ===");
process.on("uncaughtException", (err) => {
    console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (err) => {
    console.error("UNHANDLED REJECTION:", err);
});
function runStartupSelfTest() {
    try {
        require("./routes");
        require("./routes/auth");
        require("./config/env");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Startup self-test failed: ${message}`);
    }
}
(0, env_1.validateRuntimeEnvOrExit)();
runStartupSelfTest();
void (async () => {
    if (process.env.SKIP_DATABASE === "true") {
        console.log("DB SKIPPED");
    }
    else {
        try {
            await (0, init_1.initDb)();
            console.log("DB CONNECTED");
        }
        catch (err) {
            console.error("DB FAILED:", err);
        }
    }
    let redis;
    try {
        if (process.env.REDIS_URL) {
            redis = new ioredis_1.default(process.env.REDIS_URL);
            console.log("REDIS CONNECTING");
        }
        else {
            console.log("REDIS SKIPPED");
        }
    }
    catch (err) {
        console.error("REDIS FAILED:", err);
    }
    void redis;
    const port = Number(process.env.PORT) || 8080;
    app_1.default.listen(port, "0.0.0.0", () => {
        console.log(`SERVER STARTED ON ${port}`);
    });
})();
