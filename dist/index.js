"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const createServer_1 = __importDefault(require("./server/createServer"));
const env_1 = require("./config/env");
const PORT = Number(process.env.PORT) || 8080;
console.log("BOOT: START");
console.log("BOOT: PORT =", PORT);
void env_1.config.JWT_SECRET;
async function start() {
    try {
        const app = (0, createServer_1.default)();
        app.listen(PORT, "0.0.0.0", () => {
            console.log(`[BOOT] Server running on port ${PORT}`);
        });
    }
    catch (err) {
        console.error("BOOT FAILURE:", err);
        process.exit(1);
    }
}
start();
process.on("unhandledRejection", (err) => {
    console.error("UNHANDLED REJECTION:", err);
    process.exit(1);
});
process.on("uncaughtException", (err) => {
    console.error("UNCAUGHT EXCEPTION:", err);
    process.exit(1);
});
