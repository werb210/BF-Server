"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDependencies = initDependencies;
const db_1 = require("../db");
const deps_1 = require("./deps");
async function initDependencies() {
    let success = false;
    for (let i = 0; i < 3; i++) {
        try {
            await db_1.pool.query("SELECT 1");
            success = true;
            break;
        }
        catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    deps_1.deps.db.ready = success;
}
