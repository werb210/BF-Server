"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
const createServer_1 = require("./createServer");
const bootstrap_1 = require("../startup/bootstrap");
const deps_1 = require("../system/deps");
async function startServer() {
    const server = (0, createServer_1.createServer)(deps_1.deps);
    // NON-BLOCKING BOOTSTRAP
    setImmediate(() => {
        (0, bootstrap_1.bootstrap)().catch((err) => {
            console.error("Bootstrap failed:", err);
        });
    });
    return server;
}
async function start() {
    await startServer();
}
if (require.main === module) {
    start().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
