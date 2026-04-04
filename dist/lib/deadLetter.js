"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushDeadLetter = pushDeadLetter;
const db_1 = require("../db");
async function pushDeadLetter(payload) {
    try {
        await (0, db_1.runQuery)(`
      INSERT INTO failed_jobs (type, data, error, created_at)
      VALUES ($1, $2::jsonb, $3, NOW())
      `, [payload.type, JSON.stringify(payload.data), payload.error]);
    }
    catch (err) {
        console.error("FAILED TO WRITE DEAD LETTER", err);
    }
}
