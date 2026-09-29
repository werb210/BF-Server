import { db } from "../../db.js";
import { logWarnSwallowed } from "../../lib/logWarnSwallowed.js"; // BF_SERVER_SILENT_QUERIES_v678

let migrationPromise: Promise<void> | null = null;

export async function createOtpSessionsTable(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = db
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
        await db.query("CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_sessions(phone);");
      })
      .then(() => undefined)
      .catch((error: any) => { logWarnSwallowed(error, "db/migrations/createOtpSessions.ts:7");
        migrationPromise = null;
        throw error;
      });
  }

  await migrationPromise;
}
