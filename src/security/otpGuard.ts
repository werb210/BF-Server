import { pool } from "../db";

const MAX_ATTEMPTS = 5;

export async function checkOtpAttempts(phone: string): Promise<void> {
  const result = await pool.query(
    `SELECT failed_count FROM otp_verifications
WHERE phone=$1
ORDER BY created_at DESC
LIMIT 1`,
    [phone]
  );

  if (result.rows.length === 0) return;

  if (result.rows[0].failed_count >= MAX_ATTEMPTS) {
    throw new Error("OTP attempts exceeded");
  }
}
