"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const db_1 = require("./db");
const migrations_1 = require("./migrations");
const logger_1 = require("./observability/logger");
async function main() {
    (0, config_1.assertEnv)();
    try {
        await (0, db_1.dbQuery)("select 1");
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "unknown_error";
        (0, logger_1.logError)("migration_check_db_unavailable", { error: message });
    }
    await (0, migrations_1.runMigrations)();
    await (0, migrations_1.assertNoPendingMigrations)();
    (0, logger_1.logInfo)("migration_check_complete");
}
if (require.main === module) {
    main().catch((err) => {
        const message = err instanceof Error ? err.message : "unknown_error";
        (0, logger_1.logError)("migration_check_failed", { error: message });
    });
}
