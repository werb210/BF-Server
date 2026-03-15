import { runMigrations } from "./migrate";

(async () => {
  try {
    console.log("Starting migrations...");
    await runMigrations();
    console.log("Migrations completed");
    process.exit(0);
  } catch (err) {
    console.error("Migration failure:", err);
    process.exit(1);
  }
})();
