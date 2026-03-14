import { db } from "../../db";

let migrationPromise: Promise<void> | null = null;

export async function createOtpSessionsTable(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = db
      .query(`
        CREATE TABLE IF NOT EXISTS otp_sessions (
          id UUID PRIMARY KEY,
          phone TEXT NOT NULL,
          code TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL
        );
      `)
      .then(() => undefined)
      .catch((error) => {
        migrationPromise = null;
        throw error;
      });
  }

  await migrationPromise;
}
