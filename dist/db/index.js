"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runQuery = runQuery;
const deps_1 = require("../system/deps");
async function runQuery(text, params) {
    if (!deps_1.deps.db.ready) {
        throw Object.assign(new Error("DB_NOT_READY"), { status: 503 });
    }
    return deps_1.deps.db.client.query(text, params);
}
