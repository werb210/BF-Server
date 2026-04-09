import { runMigrations as runCoreMigrations } from "./migrationRunner.js";

export async function runMigrations(): Promise<void> {
  await runCoreMigrations();
}
