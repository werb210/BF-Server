"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupShutdown = setupShutdown;
const db_1 = require("../db");
function setupShutdown(server) {
    const shutdown = async () => {
        console.log("[SHUTDOWN] closing");
        try {
            await db_1.pool.end();
        }
        catch {
            // noop
        }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 10000);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
