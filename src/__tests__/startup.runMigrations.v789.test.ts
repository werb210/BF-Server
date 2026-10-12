// BF_SERVER_v789_MIGRATIONS_STRICT / _MIGRATION_SESSION / _MIGRATION_LOCK_WAIT
// The pg client is faked and answers by SQL content only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { MigrationLockTimeoutError, runMigrations } from "../startup/runMigrations.js";

let dir = "";
const write = (name: string, sql: string) => fs.writeFileSync(path.join(dir, "migrations", name), sql);

type Opts = {
  recorded?: string[];
  failOn?: string;
  failCode?: string;
  lockFreeAfter?: number; // number of pg_try_advisory_lock calls that return false first
};

function fakePool(opts: Opts = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let lockAttempts = 0;
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/pg_try_advisory_lock/i.test(sql)) {
        lockAttempts += 1;
        const free = opts.lockFreeAfter === undefined || lockAttempts > opts.lockFreeAfter;
        return { rows: [{ locked: free }] };
      }
      if (/information_schema\.columns/i.test(sql)) return { rows: [{ exists: true }] };
      if (/^SELECT id FROM schema_migrations$/i.test(sql)) return { rows: (opts.recorded ?? []).map((id) => ({ id })) };
      if (opts.failOn && sql === opts.failOn) throw Object.assign(new Error("boom"), { code: opts.failCode ?? "42P07" });
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), query: vi.fn() };
  return { pool: pool as unknown as Pool, rawPool: pool, calls, client, lockAttempts: () => lockAttempts };
}

let logs: string[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig789-"));
  fs.mkdirSync(path.join(dir, "migrations"));
  write("001_a.sql", "create table if not exists a(id int);");
  write("002_b.sql", "create table if not exists b(id int);");
  write("003_c.sql", "create table if not exists c(id int);");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("item 22: no tolerated errors", () => {
  it("rolls back a failing file, does not record it, and stops before later files", async () => {
    const { pool, calls } = fakePool({ recorded: ["001_a.sql"], failOn: "create table if not exists b(id int);" });
    await expect(runMigrations(pool)).rejects.toThrow("boom");
    const failIdx = calls.findIndex((c) => c.sql === "create table if not exists b(id int);");
    expect(calls[failIdx + 1].sql).toBe("ROLLBACK");
    expect(calls.some((c) => /INSERT INTO schema_migrations/i.test(c.sql) && (c.params ?? [])[0] === "002_b.sql")).toBe(false);
    expect(calls.some((c) => c.sql === "create table if not exists c(id int);")).toBe(false);
    expect(logs.some((l) => l.includes("All migrations applied"))).toBe(false);
  });

  it("no error code is tolerated, including the 'already exists' family the old list skipped", async () => {
    for (const code of ["42P07", "42701", "42710", "42P06", "42723", "23505"]) {
      const { pool, calls } = fakePool({ recorded: ["001_a.sql"], failOn: "create table if not exists b(id int);", failCode: code });
      await expect(runMigrations(pool), code).rejects.toMatchObject({ code });
      expect(calls.some((c) => /INSERT INTO schema_migrations/i.test(c.sql) && (c.params ?? [])[0] === "002_b.sql"), code).toBe(false);
      expect(calls.some((c) => c.sql === "create table if not exists c(id int);"), code).toBe(false);
      expect(calls.some((c) => c.sql === "COMMIT" && calls.indexOf(c) > calls.findIndex((x) => x.sql === "create table if not exists b(id int);")), code).toBe(false);
    }
  });

  it("rolls back and throws when the baseline itself fails", async () => {
    write("000000_baseline.sql", "CREATE TABLE public.applications (id text);");
    const { pool, calls } = fakePool({ failOn: "CREATE TABLE public.applications (id text);" });
    // to_regclass answers rows: [] -> exists undefined -> treated as empty database
    await expect(runMigrations(pool)).rejects.toThrow("boom");
    expect(calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
    expect(calls.some((c) => c.sql === "COMMIT")).toBe(false);
  });
});

describe("item 23: dedicated client session settings", () => {
  it("sets statement_timeout 0 and lock_timeout 30s before migrating, and destroys the client", async () => {
    const { pool, calls, client, rawPool } = fakePool({ recorded: ["001_a.sql"] });
    await runMigrations(pool);
    const st = calls.findIndex((c) => /SET statement_timeout = 0/i.test(c.sql));
    const lt = calls.findIndex((c) => /SET lock_timeout = '30s'/i.test(c.sql));
    const firstMigration = calls.findIndex((c) => c.sql === "create table if not exists b(id int);");
    expect(st).toBeGreaterThanOrEqual(0);
    expect(lt).toBeGreaterThanOrEqual(0);
    expect(st).toBeLessThan(firstMigration);
    expect(lt).toBeLessThan(firstMigration);
    // Never on the shared pool.
    expect(rawPool.query).not.toHaveBeenCalled();
    // release(true) destroys the connection so the SETs never reach other code.
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("destroys the client on failure too", async () => {
    const { pool, client } = fakePool({ failOn: "create table if not exists a(id int);" });
    await expect(runMigrations(pool)).rejects.toThrow();
    expect(client.release).toHaveBeenCalledWith(true);
  });
});

describe("item 24: migration lock wait", () => {
  function clock() {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => { slept.push(ms); t += ms; },
      slept,
    };
  }

  it("keeps polling past 10s and runs the migrations once the lock frees", async () => {
    const c = clock();
    // 500ms polls for 10s = 20 failures, then 3 slow polls, then free.
    const { pool, calls, lockAttempts } = fakePool({ recorded: [], lockFreeAfter: 23 });
    await runMigrations(pool, { now: c.now, sleep: c.sleep });
    expect(lockAttempts()).toBe(24);
    expect(c.slept.slice(0, 20).every((ms) => ms === 500)).toBe(true);
    expect(c.slept.slice(20).every((ms) => ms === 5000)).toBe(true);
    expect(calls.some((c2) => c2.sql === "create table if not exists a(id int);")).toBe(true);
    expect(logs.some((l) => l.includes("All migrations applied"))).toBe(true);
  });

  it("throws MigrationLockTimeoutError after the timeout instead of booting on an old schema", async () => {
    const c = clock();
    const { pool, calls, client } = fakePool({ recorded: [], lockFreeAfter: Number.MAX_SAFE_INTEGER });
    await expect(runMigrations(pool, { now: c.now, sleep: c.sleep })).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    const total = c.slept.reduce((a, b) => a + b, 0);
    expect(total).toBe(5 * 60_000);
    expect(calls.some((c2) => c2.sql === "BEGIN")).toBe(false);
    expect(calls.some((c2) => /pg_advisory_unlock/i.test(c2.sql))).toBe(false);
    expect(logs.some((l) => l.includes("All migrations applied"))).toBe(false);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("timings are injectable", async () => {
    const c = clock();
    const { pool } = fakePool({ lockFreeAfter: Number.MAX_SAFE_INTEGER });
    await expect(
      runMigrations(pool, { now: c.now, sleep: c.sleep, lockPollMs: 10, lockFastPhaseMs: 50, lockSlowPollMs: 100, lockTimeoutMs: 1050 }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    expect(c.slept.reduce((a, b) => a + b, 0)).toBe(1050);
    expect(c.slept[0]).toBe(10);
    expect(c.slept[c.slept.length - 1]).toBe(100);
  });

  it("logs All migrations applied only after success and unlocks", async () => {
    const { pool, calls } = fakePool({ recorded: ["001_a.sql", "002_b.sql", "003_c.sql"] });
    await runMigrations(pool);
    expect(logs.some((l) => l.includes("All migrations applied (0 new"))).toBe(true);
    expect(calls.some((c2) => /pg_advisory_unlock/i.test(c2.sql))).toBe(true);
  });
});
