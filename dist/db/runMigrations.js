"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const migrate_1 = require("./migrate");
(async () => {
    try {
        console.log("Starting migrations...");
        await (0, migrate_1.runMigrations)();
        console.log("Migrations completed");
        process.exit(0);
    }
    catch (err) {
        console.error("Migration failure:", err);
        process.exit(1);
    }
})();
