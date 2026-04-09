import { assertEnv } from "./config/index.js";
import { dbQuery } from "./db.js";
import { assertNoPendingMigrations, runMigrations } from "./migrations.js";
import { logError, logInfo } from "./observability/logger.js";
async function main() {
    assertEnv();
    try {
        await dbQuery("select 1");
    }
    catch (err) {
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
