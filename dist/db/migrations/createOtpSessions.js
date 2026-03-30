"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOtpSessionsTable = createOtpSessionsTable;
const db_1 = require("../../db");
let migrationPromise = null;
async function createOtpSessionsTable() {
    if (!migrationPromise) {
        migrationPromise = db_1.db
            .query(`
        CREATE TABLE IF NOT EXISTS otp_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone TEXT NOT NULL,
          code TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMP NOT NULL
        );
      `)
            .then(async () => {
            await db_1.db.query("CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_sessions(phone);");
        })
            .then(() => undefined)
            .catch((error) => {
            migrationPromise = null;
            throw error;
        });
    }
    await migrationPromise;
}
