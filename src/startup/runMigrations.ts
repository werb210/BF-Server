import fs from "fs";
import path from "path";
import type { Pool, PoolClient } from "pg";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js"; // BF_SERVER_SILENT_QUERIES_v678

// BF_SERVER_v789_MIGRATIONS_STRICT - there is no tolerated-error list any more.
// Migrations are idempotent by rule (IF NOT EXISTS / NOT EXISTS), production
// already has its history recorded and a fresh database loads the baseline, so
// an error is a real error: the file is rolled back, NOT recorded, and the
// throw stops startup (src/index.ts exits non-zero so App Service restarts
// instead of serving on a half-migrated schema).

const MIGRATION_ADVISORY_LOCK_KEY = 8732914055n;

// BF_SERVER_BLOCK_v681_MIGRATION_LOCK_NONBLOCKING_v1
// Was BLOCKING pg_advisory_lock(): two instances booting at once (staging slot
// + production) collided and the loser hung forever inside pg_advisory_lock.
// The lock is still taken NON-BLOCKING with pg_try_advisory_lock().
// BF_SERVER_v789_MIGRATION_LOCK_WAIT - v681 then BOOTED ANYWAY after ~10s
// without running migrations, i.e. it served traffic on an old schema. Now it
// polls quickly for the first 10s, then keeps polling (slower) for up to 5
// minutes; if the lock is still held it throws MigrationLockTimeoutError, so
// the process exits non-zero and App Service restarts it.
export type RunMigrationsOptions = {
  /** Poll interval during the fast phase. */
  lockPollMs?: number;
  /** Length of the fast phase (default 10s); a warning is logged after it. */
  lockFastPhaseMs?: number;
  /** Poll interval after the fast phase. */
  lockSlowPollMs?: number;
  /** Total time to wait for the lock before giving up (default 5 minutes). */
  lockTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_LOCK_POLL_MS = 500;
const DEFAULT_LOCK_FAST_PHASE_MS = 10_000;
const DEFAULT_LOCK_SLOW_POLL_MS = 5_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60_000;

export class MigrationLockTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`[MIGRATIONS] migration lock still held by another instance after ${Math.round(waitedMs / 1000)}s; refusing to boot on an unmigrated schema`);
    this.name = "MigrationLockTimeoutError";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireMigrationLock(client: PoolClient, opts: RunMigrationsOptions): Promise<void> {
  const pollMs = opts.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  const fastPhaseMs = opts.lockFastPhaseMs ?? DEFAULT_LOCK_FAST_PHASE_MS;
  const slowPollMs = opts.lockSlowPollMs ?? DEFAULT_LOCK_SLOW_POLL_MS;
  const timeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let warned = false;
  for (let attempt = 1; ; attempt++) {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [String(MIGRATION_ADVISORY_LOCK_KEY)]
    );
    if (res.rows[0]?.locked === true) return;
    const waited = now() - startedAt;
    if (waited >= timeoutMs) throw new MigrationLockTimeoutError(waited);
    const fast = waited < fastPhaseMs;
    if (!fast && !warned) {
      warned = true;
      console.warn(`[MIGRATIONS] lock still held by another instance after ${Math.round(waited / 1000)}s; waiting up to ${Math.round(timeoutMs / 1000)}s, then exiting`);
    }
    const delay = Math.max(1, Math.min(fast ? pollMs : slowPollMs, timeoutMs - waited));
    console.log(`[MIGRATIONS] lock held by another instance; retry ${attempt} in ${delay}ms`);
    await sleep(delay);
  }
}

// BF_SERVER_v789_MIGRATION_SESSION - session settings for the migration client
// only. statement_timeout 0 so a long backfill is not cut off by a role or
// database default; lock_timeout 30s so DDL stuck behind live traffic fails
// loudly instead of queueing every other query behind it. The connection is
// destroyed afterwards (release(true)), so the pool never hands these settings,
// or the baseline's search_path, to other code.
async function applyMigrationSessionSettings(client: PoolClient): Promise<void> {
  await client.query("SET statement_timeout = 0");
  await client.query("SET lock_timeout = '30s'");
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

// Message + code only: a pg error object references the live connection.
function errSummary(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown } | null | undefined;
  const code = e && typeof e.code === "string" ? ` (code ${e.code})` : "";
  return String(e?.message ?? err) + code;
}

export async function runMigrations(pool: Pool, opts: RunMigrationsOptions = {}): Promise<void> {
  const migrationsDir = path.join(process.cwd(), "migrations");
  if (!fs.existsSync(migrationsDir)) {
    console.log("[MIGRATIONS] No migrations directory - skipping (nothing to apply).");
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
    await applyMigrationSessionSettings(client);
    await acquireMigrationLock(client, opts);
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
          let recorded = 0;
          await client.query("BEGIN");
          try {
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
            // BF_SERVER_BASELINE_MANIFEST_v678 - only the files the snapshot was taken from are
            // "already applied". Migrations written after the snapshot are listed nowhere, so they
            // run below like on any other database - CI databases get every new table without the
            // snapshot being regenerated.
            const manifestPath = path.join(migrationsDir, "000000_baseline.files.txt");
            const covered = fs.existsSync(manifestPath)
              ? new Set(fs.readFileSync(manifestPath, "utf8").split(NL).map((l) => l.split(CR).join("").trim()).filter(Boolean))
              : null;
            for (const f of ordinaryFiles) {
              if (covered && !covered.has(f)) continue;
              recorded += 1;
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
          } catch (err) {
            // BF_SERVER_v789_MIGRATIONS_STRICT - a failed baseline leaves nothing behind.
            await client.query("ROLLBACK").catch((swallowedErr: unknown) => { logWarnSwallowed(swallowedErr, "startup/runMigrations.ts:baseline_rollback");});
            console.error("[MIGRATIONS] FATAL loading the schema baseline", errSummary(err));
            throw err;
          }
          // The dump SETs lock_timeout / statement_timeout for the session; put ours back.
          await applyMigrationSessionSettings(client);
          applied = await fetchApplied(client);
          console.log(`[MIGRATIONS] baseline applied; ${recorded} historical migrations recorded, ${ordinaryFiles.length - recorded} newer ones will run`);
        }
      }

      let newlyApplied = 0;
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
          newlyApplied += 1;
          console.log(`[MIGRATIONS] applied: ${file}`);
        } catch (err) {
          // BF_SERVER_v789_MIGRATIONS_STRICT - any error: roll back, do not record, stop.
          await client.query("ROLLBACK").catch((swallowedErr: unknown) => { logWarnSwallowed(swallowedErr, "startup/runMigrations.ts:192");});
          console.error(`[MIGRATIONS] FATAL on ${file}`, errSummary(err));
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
      // BF_SERVER_v789_MIGRATION_LOCK_WAIT - logged here, and only here: every file is applied.
      console.log(`[MIGRATIONS] All migrations applied (${newlyApplied} new this boot).`);
    } finally {
      await releaseMigrationLock(client);
    }
  } finally {
    // BF_SERVER_v789_MIGRATION_SESSION - destroy, never return to the pool: the
    // connection carries session-level SETs (ours and the baseline's).
    client.release(true);
  }
}
