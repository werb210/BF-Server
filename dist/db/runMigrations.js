import { runMigrations } from "./migrate.js";
(async () => {
    try {
        console.log("Starting migrations...");
        await runMigrations();
        console.log("Migrations completed");
    }
    catch (err) {
        console.error("Migration failure:", err);
        throw err;
    }
})();
