import { runMigrations as runCoreMigrations } from "./migrationRunner";

export async function runMigrations(): Promise<void> {
  await runCoreMigrations();
}
