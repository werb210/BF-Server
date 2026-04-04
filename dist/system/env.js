"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnv = validateEnv;
const env_1 = require("../config/env");
function validateEnv() {
    const { PORT, NODE_ENV } = (0, env_1.getEnv)();
    if (NODE_ENV !== "test" && !process.env.DB_URL) {
        throw new Error("MISSING_DB_URL");
    }
}
