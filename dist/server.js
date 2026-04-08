"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildApp = buildApp;
exports.startServer = startServer;
require("dotenv/config");
const app_1 = require("./app");
const init_1 = require("./db/init");
async function buildApp() {
    return (0, app_1.createApp)();
}
async function startServer() {
    if (process.env.NODE_ENV !== "test") {
        await (0, init_1.initDb)();
    }
    const app = await buildApp();
    const port = Number(process.env.PORT) || 8080;
    return app.listen(port, "0.0.0.0", () => {
        console.log(`SERVER STARTED ON ${port}`);
    });
}
