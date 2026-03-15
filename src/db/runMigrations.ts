import { runMigrations } from "./migrationRunner";

runMigrations()
  .then(() => {
    process.stdout.write("Migrations completed successfully.\n");
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
