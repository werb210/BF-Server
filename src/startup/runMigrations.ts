import fs from "fs";
import path from "path";
import type { Pool, PoolClient } from "pg";

// Postgres error codes we treat as "already-there, safe to skip":
//   42P07 duplicate table · 42710 duplicate object · 42701 duplicate column
//   42P16 invalid table def · 42P06 duplicate schema · 42P05 dup prepared stmt
//   42P03 duplicate cursor · 42704 undefined object (older PG IF EXISTS)
const IDEMPOTENT_CODES = new Set(["42P07", "42710", "42701", "42P16", "42P06", "42P05", "42P03", "42704"]);

const MIGRATION_ADVISORY_LOCK_KEY = 8732914055n;

// BF_SERVER_BLOCK_v681_MIGRATION_LOCK_NONBLOCKING_v1
// Was BLOCKING pg_advisory_lock(): two instances booting at once (staging slot
// + production, which happens on every deploy/swap) collided — one took the
// lock, the other blocked FOREVER inside pg_advisory_lock and never reached
// app.listen(). Azure killed the blocked instance, it restarted, collided
// again, and both slots crash-looped with nobody able to log in.
// Now: NON-BLOCKING pg_try_advisory_lock() with a short bounded retry. If
// another instance is already applying the (additive-only) migrations, this
// one gives up after the budget and BOOTS ANYWAY without running them —
// serving traffic beats hanging. A genuinely broken migration still throws and
// stays fatal upstream; only the lock-contention hang is removed.
const LOCK_RETRY_ATTEMPTS = 20;
const LOCK_RETRY_DELAY_MS = 500; // up to ~10s before booting anyway

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryAcquireMigrationLock(client: PoolClient): Promise<boolean> {
  for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [String(MIGRATION_ADVISORY_LOCK_KEY)]
    );
    if (res.rows[0]?.locked === true) return true;
    if (attempt < LOCK_RETRY_ATTEMPTS) {
      console.log(`[MIGRATIONS] lock held by another instance; retry ${attempt}/${LOCK_RETRY_ATTEMPTS} in ${LOCK_RETRY_DELAY_MS}ms`);
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  return false;
}

async function releaseMigrationLock(client: PoolClient): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [String(MIGRATION_ADVISORY_LOCK_KEY)]);
  } catch (err) {
    console.warn("migration_advisory_unlock_failed", err);
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

  // BF_SERVER_SCHEMA_BASELINE_v159 - kept out of `files` so it is never applied
  // as an ordinary migration on a database that already has a schema.
  const BASELINE_FILE = "000000_baseline.sql";
  const ordinaryFiles = files.filter((f) => f !== BASELINE_FILE);

  const client = await pool.connect();
  try {
    const acquired = await tryAcquireMigrationLock(client);
    if (!acquired) {
      console.warn("[MIGRATIONS] another instance holds the migration lock; skipping migrations and booting to serve traffic.");
      return;
    }
    try {
      await ensureTrackingTable(client);
      let applied = await fetchApplied(client);

      // BF_SERVER_SCHEMA_BASELINE_v159
      // Only on a genuinely empty database: no recorded history AND no
      // applications table. Both conditions, because a half-built database is
      // not something to overwrite silently - it is something to look at.
      if (applied.size === 0 && fs.existsSync(path.join(migrationsDir, BASELINE_FILE))) {
        const hasSchema = await client.query<{ exists: boolean }>(
          "SELECT to_regclass('public.applications') IS NOT NULL AS exists",
        );
        if (hasSchema.rows[0]?.exists) {
          console.warn("[MIGRATIONS] tables exist but schema_migrations is empty - NOT applying the baseline. Check the database.");
        } else {
          console.log("[MIGRATIONS] empty database - applying schema baseline");
          const raw = fs.readFileSync(path.join(migrationsDir, BASELINE_FILE), "utf8");
          // pg_dump 17.6+ brackets its output with restrict / unrestrict psql
          // meta-commands. The node pg client cannot parse them, so they are
          // dropped. No backslash or escape sequence appears below on purpose:
          // this file is generated through two layers of escaping and they were
          // wrong twice. Char codes cannot be mangled that way.
          const NL = String.fromCharCode(10);
          const CR = String.fromCharCode(13);
          const BACKSLASH = 92;
          const baselineSql = raw
            .split(NL)
            .filter((line) => {
              const t = line.trim().split(CR).join("");
              if (t.charCodeAt(0) !== BACKSLASH) return true;
              const rest = t.slice(1);
              return !(rest.startsWith("restrict") || rest.startsWith("unrestrict"));
            })
            .join(NL);

          // The dump contains schema_migrations, which ensureTrackingTable has
          // just created. Drop it so the baseline restores its real definition,
          // then the inserts below repopulate it - rather than teaching the
          // baseline to be idempotent, which is not ours to edit.
          await client.query("BEGIN");
          await client.query("DROP TABLE IF EXISTS schema_migrations");
          await client.query(baselineSql);
          // pg_dump emits SET search_path = '' and qualifies every object, so
          // anything unqualified after it fails with "no schema has been
          // selected to create in". Put it back before touching the tracking
          // table or inserting a single row.
          await client.query("SET search_path TO public");
          await ensureTrackingTable(client);
          // Everything the baseline already contains is, by definition, applied.
          // Recording every historical filename is what stops the 22 broken ones
          // from running against a schema that already has their tables.
          for (const f of ordinaryFiles) {
            await client.query(
              "INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
              [f],
            );
          }
          await client.query(
            "INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
            [BASELINE_FILE],
          );
          await client.query("COMMIT");
          applied = await fetchApplied(client);
          console.log(`[MIGRATIONS] baseline applied; ${ordinaryFiles.length} historical migrations recorded`);
        }
      }

      for (const file of ordinaryFiles) {
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

      const expected: Array<{ table: string; column: string; migration: string }> = [
        { table: "lender_products", column: "amount_min", migration: "121_readd_amount_columns_and_repair.sql" },
        { table: "lender_products", column: "amount_max", migration: "121_readd_amount_columns_and_repair.sql" },
        { table: "users", column: "silos", migration: "130_users_silos_array.sql" },
        { table: "lenders", column: "silo", migration: "131_lenders_silo_column.sql" },
        { table: "lender_products", column: "silo", migration: "131_lenders_silo_column.sql" },
        { table: "applications", column: "silo", migration: "132_recovery_columns.sql" },
        { table: "contacts", column: "company_name", migration: "132_recovery_columns.sql" },
      ];

      for (const e of expected) {
        const r = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
           ) AS exists`,
          [e.table, e.column]
        );
        if (!r.rows[0]?.exists) {
          console.error(
            `[MIGRATIONS][SCHEMA-DRIFT] expected column ${e.table}.${e.column} ` +
            `missing despite ${e.migration} marked applied. Run the schema recovery SQL.`
          );
        }
      }
    } finally {
      await releaseMigrationLock(client);
    }
  } finally {
    client.release();
  }
}
