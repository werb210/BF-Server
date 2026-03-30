"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
require("./env");
const createServer_1 = require("./server/createServer");
const runtimeGuards_1 = require("./server/runtimeGuards");
(0, runtimeGuards_1.assertRequiredEnv)();
(0, runtimeGuards_1.assertSingleServerStart)();
process.on("unhandledRejection", (err) => {
    console.error("UNHANDLED REJECTION:", err);
});
process.on("uncaughtException", (err) => {
    console.error("UNCAUGHT EXCEPTION:", err);
});
console.log("BOOT START");
const app = (0, createServer_1.createServer)();
exports.app = app;
try {
    const port = process.env.PORT || 8080;
    const listenPort = typeof port === "string" ? Number(port) : port;
    if (process.env.NODE_ENV !== "test") {
        app.listen(listenPort, "0.0.0.0", () => {
            console.log(`Server running on ${port}`);
        });
    }
}
catch (err) {
    console.error("BOOT FAILURE", err);
}
