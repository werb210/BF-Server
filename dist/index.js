"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const app_1 = require("./app");
const verifyRuntime_1 = require("./startup/verifyRuntime");
const app = (0, app_1.createApp)();
app.get("/health", (_req, res) => {
    res.status(200).send("ok");
});
app.get("/ready", (_req, res) => {
    res.status(200).send("ready");
});
void (async () => {
    try {
        await (0, verifyRuntime_1.verifyRuntime)();
    }
    catch (err) {
        console.error("💥 STARTUP FAILED — EXITING");
        process.exit(1);
    }
    const port = Number(process.env.PORT) || 8080;
    app.listen(port, "0.0.0.0", () => {
        console.log(`SERVER STARTED ON ${port}`);
    });
})();
