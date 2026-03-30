"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
const createServer_1 = require("./createServer");
const bootstrap_1 = require("../startup/bootstrap");
async function startServer() {
    await (0, bootstrap_1.bootstrap)();
    return (0, createServer_1.createServer)();
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
