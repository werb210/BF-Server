import { pool, runQuery } from "../db";

const MAX_ATTEMPTS = 5;

export async function checkOtpAttempts(phone: string): Promise<void> {
  const result = await runQuery(
    `SELECT failed_count FROM otp_verifications
WHERE phone=$1
ORDER BY created_at DESC
LIMIT 1`,
    [phone]
  );

  if (result.rows.length === 0) return;

  const latest = result.rows[0];
  if (latest && latest.failed_count >= MAX_ATTEMPTS) {
    throw new Error("OTP attempts exceeded");
  }
}
