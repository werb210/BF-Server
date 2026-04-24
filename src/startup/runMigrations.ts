import fs from "fs";
import path from "path";
import type { Pool, PoolClient } from "pg";

// Postgres error codes we treat as "already-there, safe to skip":
//   42P07 - duplicate table
//   42710 - duplicate object (type/extension/etc)
//   42701 - duplicate column
//   42P16 - invalid table definition (e.g. "already IDENTITY")
//   42P06 - duplicate schema
//   42P05 - duplicate prepared statement
//   42P03 - duplicate cursor
//   42704 - undefined object when using IF EXISTS variant that older PG rejects
const IDEMPOTENT_CODES = new Set(["42P07", "42710", "42701", "42P16", "42P06", "42P05", "42P03", "42704"]);

// A single, stable lock key derived at random-once, hardcoded here so every
// process across every Azure instance uses the same lock.
const MIGRATION_ADVISORY_LOCK_KEY = 8732914055n;

async function withAdvisoryLock<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("SELECT pg_advisory_lock($1)", [String(MIGRATION_ADVISORY_LOCK_KEY)]);
  try {
    return await fn();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [String(MIGRATION_ADVISORY_LOCK_KEY)]);
    } catch (err) {
      console.warn("migration_advisory_unlock_failed", err);
    }
  }
}

async function ensureTrackingTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function fetchApplied(client: PoolClient): Promise<Set<string>> {
  const res = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
  return new Set(res.rows.map((r) => r.id));
}

function pgErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = path.join(process.cwd(), "migrations");
  if (!fs.existsSync(migrationsDir)) {
    console.log("[MIGRATIONS] No migrations directory — skipping.");
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  try {
    await withAdvisoryLock(client, async () => {
      await ensureTrackingTable(client);
      const applied = await fetchApplied(client);

      for (const file of files) {
        if (applied.has(file)) continue;

        const sqlPath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(sqlPath, "utf8");

        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
            [file]
          );
          await client.query("COMMIT");
          applied.add(file);
          console.log(`[MIGRATIONS] applied: ${file}`);
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          const code = pgErrorCode(err);
          if (code && IDEMPOTENT_CODES.has(code)) {
            console.warn(`[MIGRATIONS] treating ${file} as already-present (code ${code})`);
            await client.query(
              "INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
              [file]
            ).catch(() => {});
            applied.add(file);
            continue;
          }
          console.error(`[MIGRATIONS] FATAL on ${file}`, err);
          throw err;
        }
      }
    });
  } finally {
    client.release();
  }
}
