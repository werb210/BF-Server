"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
const env_1 = require("./config/env");
const PORT = process.env.PORT || 8080;
async function start() {
    try {
        // Only validate env — do NOT call external services
        (0, env_1.validateEnv)();
        app_1.default.listen(PORT, () => {
            console.log(`SERVER STARTED ON ${PORT}`);
        });
    }
    catch (err) {
        console.error("Startup failed:", err);
        process.exit(1);
    }
}
start();
