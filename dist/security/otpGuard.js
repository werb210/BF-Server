"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkOtpAttempts = checkOtpAttempts;
const db_1 = require("../db");
const MAX_ATTEMPTS = 5;
async function checkOtpAttempts(phone) {
    const result = await (0, db_1.runQuery)(`SELECT failed_count FROM otp_verifications
WHERE phone=$1
ORDER BY created_at DESC
LIMIT 1`, [phone]);
    if (result.rows.length === 0)
        return;
    if (result.rows[0].failed_count >= MAX_ATTEMPTS) {
        throw new Error("OTP attempts exceeded");
    }
}
