import { runMigrations as runCoreMigrations } from "../migrations.js";

export async function runMigrations(): Promise<void> {
  await runCoreMigrations();
}
