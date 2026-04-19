import fs from "fs";
import path from "path";
import type { Pool } from "pg";

type MigrationRow = { id: string };
type RegclassRow = { exists: string | null };

const KNOWN_IDEMPOTENT_CODES = new Set(["42P07", "42710"]);

function getPgErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }

  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function resolveTrackingTable(pool: Pool): Promise<string> {
  const appliedRes = await pool.query<RegclassRow>(
    "select to_regclass('public.applied_migrations') as exists"
  );

  if (appliedRes.rows[0]?.exists) {
    return "applied_migrations";
  }

  await pool.query(
    `create table if not exists schema_migrations (
      id text,
      applied_at timestamp
    )`
  );

  return "schema_migrations";
}

async function fetchAppliedMigrations(pool: Pool, tableName: string): Promise<Set<string>> {
  const res = await pool.query<MigrationRow>(`select id from ${tableName}`);
  return new Set(res.rows.map((row) => row.id));
}

export async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = path.join(process.cwd(), "migrations");

  if (!fs.existsSync(migrationsDir)) {
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const trackingTable = await resolveTrackingTable(pool);
  const applied = await fetchAppliedMigrations(pool, trackingTable);

  await pool.query("begin");

  try {
    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      const savepointName = `migration_${file.replace(/[^a-zA-Z0-9_]/g, "_")}`;

      await pool.query(`savepoint ${savepointName}`);

      try {
        await pool.query(sql);
        await pool.query(
          `insert into ${trackingTable} (id, applied_at) values ($1, now())`,
          [file]
        );
        applied.add(file);
        console.log(`migration_applied: ${file}`);
        await pool.query(`release savepoint ${savepointName}`);
      } catch (err) {
        await pool.query(`rollback to savepoint ${savepointName}`);
        await pool.query(`release savepoint ${savepointName}`);

        const code = getPgErrorCode(err);
        if (code && KNOWN_IDEMPOTENT_CODES.has(code)) {
          console.warn(`migration_already_present: ${file} (${code})`);
          await pool.query(
            `insert into ${trackingTable} (id, applied_at) values ($1, now())`,
            [file]
          );
          applied.add(file);
        } else {
          console.error(`migration_failed: ${file}`, err);
        }
      }
    }

    await pool.query("commit");
  } catch (err) {
    await pool.query("rollback");
    throw err;
  }
}
