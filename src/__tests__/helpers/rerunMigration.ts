// BF_SERVER_v886_MIGRATION_RERUN - integration files share one database and run in parallel. A file that re-runs a
// migration takes table-level locks (ALTER TABLE ...) while other files run ordinary queries on the same tables, and
// twice that ended in "deadlock detected", failing whichever side Postgres picked - often a file that was only
// cleaning up. Here the migration runs in a transaction that waits at most 500 ms for each lock - less than
// Postgres's 1 s deadlock check - so it gives way first (rolling back, releasing everything) and tries again,
// instead of holding locks that block someone else. Migrations are idempotent, so running again is safe.
import type { Pool } from "pg";

const RETRY_CODES = new Set(["55P03", "40P01"]); // lock_not_available, deadlock_detected

export async function rerunMigration(pool: Pool, sql: string, attempts = 40): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '500ms'");
      await client.query(sql);
      await client.query("COMMIT");
      return;
    } catch (err: any) {
      try { await client.query("ROLLBACK"); } catch (rollbackErr) { console.warn("[rerunMigration] rollback failed", String(rollbackErr)); }
      if (attempt >= attempts || !RETRY_CODES.has(String(err?.code))) throw err;
      await new Promise((r) => setTimeout(r, 100 + Math.floor(Math.random() * 300)));
    } finally {
      client.release();
    }
  }
}
