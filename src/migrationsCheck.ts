// BF_SERVER_v789_DEAD_CODE - CLI check that applies pending migrations with the same
// runner the server uses on boot (src/startup/runMigrations.ts). The runner throws
// on any failure, so a clean exit means every migration file is applied.
//   node dist/migrationsCheck.js
import { fileURLToPath } from "url";
import { assertEnv } from "./config/index.js";
import { pool } from "./db.js";
import { runMigrations } from "./startup/runMigrations.js";
import { logError, logInfo } from "./observability/logger.js";

async function main(): Promise<void> {
  assertEnv();
  await runMigrations(pool);
  logInfo("migration_check_complete");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then(() => pool.end())
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : "unknown_error";
      logError("migration_check_failed", { error: message });
      await pool.end().catch((endErr) => logError("migration_check_pool_end_failed", { error: String(endErr) }));
      process.exit(1);
    });
}
