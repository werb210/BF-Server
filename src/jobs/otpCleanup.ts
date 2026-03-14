import type { Pool } from "pg";

export async function cleanupOtpSessions(database: Pick<Pool, "query">): Promise<void> {
  await database.query(`
    DELETE FROM otp_sessions
    WHERE expires_at < NOW()
  `);
}
