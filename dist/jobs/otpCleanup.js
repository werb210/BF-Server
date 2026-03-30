"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupOtpSessions = cleanupOtpSessions;
async function cleanupOtpSessions(database) {
    await database.query(`
    DELETE FROM otp_sessions
    WHERE expires_at < NOW()
  `);
}
