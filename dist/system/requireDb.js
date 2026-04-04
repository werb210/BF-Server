"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireDb = requireDb;
const deps_1 = require("./deps");
function requireDb() {
    if (!deps_1.deps.db.ready) {
        const err = new Error("DB_NOT_READY");
        err.status = 503;
        throw err;
    }
}
