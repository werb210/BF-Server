import { assertEnv } from "./config";
import { dbQuery } from "./db";
import { assertNoPendingMigrations, runMigrations } from "./migrations";
import { logError, logInfo } from "./observability/logger";

async function main(): Promise<void> {
  assertEnv();
  try {
    await dbQuery("select 1");
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    logError("migration_check_db_unavailable", { error: message });
  }
  await runMigrations();
  await assertNoPendingMigrations();
  logInfo("migration_check_complete");
}

if (require.main === module) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : "unknown_error";
    logError("migration_check_failed", { error: message });
  });
}
