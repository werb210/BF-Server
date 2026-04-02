import fs from "fs";
import path from "path";
import type { Pool } from "pg";

export async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = path.join(process.cwd(), "server/migrations");

  if (!fs.existsSync(migrationsDir)) {
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");

    try {
      await pool.query(sql);
      console.log(`migration_applied: ${file}`);
    } catch (err) {
      console.warn(`migration_skipped_or_failed: ${file}`, err);
    }
  }
}
