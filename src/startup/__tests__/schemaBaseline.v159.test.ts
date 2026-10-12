// BF_SERVER_SCHEMA_BASELINE_v159
// Verified against a real Postgres 16: the runner dies on
// 018_ocr_results_fields.sql, and roughly 22 migrations fail in total on an
// empty database. Production boots only because all of them are already
// recorded in schema_migrations.
// The runner is driven against a temporary migrations directory with the pg
// client faked; it answers by SQL content only.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import fs, { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";
import type { Pool } from "pg";
import { runMigrations } from "../runMigrations.js";

const MIGRATIONS = resolve(process.cwd(), "migrations");
const BASELINE = "000000_baseline.sql";
const BASELINE_SQL = "CREATE TABLE public.applications (id text);";

let dir = "";
let logs: string[] = [];
let warnings: string[] = [];
const write = (name: string, sql: string) => fs.writeFileSync(path.join(dir, "migrations", name), sql);

function fakePool(opts: { recorded?: string[]; tablesExist?: boolean } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  // schema_migrations as the database would hold it.
  const history = new Set(opts.recorded ?? []);
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ locked: true }] };
      if (/to_regclass\('public\.applications'\)/.test(sql)) return { rows: [{ exists: opts.tablesExist === true }] };
      if (/information_schema\.columns/i.test(sql)) return { rows: [{ exists: true }] };
      if (/^SELECT id FROM schema_migrations$/i.test(sql)) return { rows: [...history].map((id) => ({ id })) };
      if (/^INSERT INTO schema_migrations/.test(sql)) history.add(String((params ?? [])[0]));
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), query: vi.fn() };
  const statements = () => calls.map((c) => c.sql);
  const recorded = () => calls.filter((c) => /INSERT INTO schema_migrations/.test(c.sql)).map((c) => (c.params ?? [])[0]);
  return { pool: pool as unknown as Pool, calls, statements, recorded };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "baseline159-"));
  fs.mkdirSync(path.join(dir, "migrations"));
  write(BASELINE, BASELINE_SQL);
  write("001_a.sql", "create table if not exists a(id int);");
  write("018_ocr_results_fields.sql", "alter table document_ocr_fields add column if not exists x text;");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  logs = [];
  warnings = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the ordering problem this exists for", () => {
  it("018 sorts before the 018b that creates the table it uses", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.startsWith("018")).sort();
    expect(files.indexOf("018_ocr_results_fields.sql"))
      .toBeLessThan(files.indexOf("018b_document_ocr_fields_bootstrap.sql"));
    const early = readFileSync(resolve(MIGRATIONS, "018_ocr_results_fields.sql"), "utf-8");
    expect(early).toContain("document_ocr_fields");
    const later = readFileSync(resolve(MIGRATIONS, "018b_document_ocr_fields_bootstrap.sql"), "utf-8");
    expect(later).toContain("create table if not exists document_ocr_fields");
  });
});

describe("the baseline only touches an empty database", () => {
  it("applies on an empty database", async () => {
    const f = fakePool();
    await runMigrations(f.pool);
    expect(f.statements()).toContain(BASELINE_SQL);
  });

  it("requires no recorded history", async () => {
    const f = fakePool({ recorded: ["001_a.sql"] });
    await runMigrations(f.pool);
    expect(f.statements()).not.toContain(BASELINE_SQL);
    expect(f.statements().some((s) => /to_regclass/.test(s))).toBe(false);
  });

  it("and requires no existing tables", async () => {
    const f = fakePool({ tablesExist: true });
    await runMigrations(f.pool).catch(() => undefined);
    const probe = f.statements().find((s) => /to_regclass/.test(s));
    expect(probe).toContain("to_regclass('public.applications') IS NOT NULL");
    expect(f.statements()).not.toContain(BASELINE_SQL);
  });

  it("refuses a half-built database rather than overwriting it", async () => {
    const f = fakePool({ tablesExist: true });
    await runMigrations(f.pool).catch(() => undefined);
    expect(warnings.some((w) => w.includes("tables exist but schema_migrations is empty - NOT applying the baseline"))).toBe(true);
    expect(f.statements()).not.toContain("DROP TABLE IF EXISTS schema_migrations");
  });

  it("is excluded from the ordinary migration loop", async () => {
    // History recorded, baseline not: it is still never run as a migration.
    const f = fakePool({ recorded: ["001_a.sql", "018_ocr_results_fields.sql"] });
    await runMigrations(f.pool);
    expect(f.statements()).not.toContain(BASELINE_SQL);
    expect(f.recorded()).not.toContain(BASELINE);
  });
});

describe("it records history so the broken migrations never run", () => {
  it("marks every historical file applied, and runs none of them", async () => {
    const f = fakePool();
    await runMigrations(f.pool);
    expect(f.recorded()).toEqual(expect.arrayContaining(["001_a.sql", "018_ocr_results_fields.sql"]));
    expect(f.statements()).not.toContain("alter table document_ocr_fields add column if not exists x text;");
    expect(f.calls.find((c) => /INSERT INTO schema_migrations/.test(c.sql))?.sql).toBe("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING");
  });

  it("records the baseline itself too", async () => {
    const f = fakePool();
    await runMigrations(f.pool);
    expect(f.recorded()).toContain(BASELINE);
  });

  it("makes room for the dump's own schema_migrations", async () => {
    // ensureTrackingTable creates it before the baseline runs, and the dump
    // contains it too - so the baseline would fail on "already exists".
    const f = fakePool();
    await runMigrations(f.pool);
    const s = f.statements();
    const drop = s.indexOf("DROP TABLE IF EXISTS schema_migrations");
    expect(drop).toBeGreaterThan(-1);
    expect(s[drop + 1]).toBe(BASELINE_SQL);
  });

  it("restores search_path, which the dump blanks", async () => {
    const f = fakePool();
    await runMigrations(f.pool);
    const s = f.statements();
    const at = s.indexOf(BASELINE_SQL);
    expect(s[at + 1]).toBe("SET search_path TO public");
    expect(s.findIndex((x) => /INSERT INTO schema_migrations/.test(x))).toBeGreaterThan(at + 1);
  });

  it("does it in one transaction", async () => {
    const f = fakePool();
    await runMigrations(f.pool);
    const s = f.statements();
    const at = s.indexOf(BASELINE_SQL);
    const begin = s.lastIndexOf("BEGIN", at);
    const commit = s.indexOf("COMMIT", at);
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(s.indexOf("DROP TABLE IF EXISTS schema_migrations"));
    const lastRecord = s.map((x, i) => (/INSERT INTO schema_migrations/.test(x) ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(commit).toBeGreaterThan(lastRecord);
    expect(s.slice(begin, commit).filter((x) => x === "COMMIT" || x === "BEGIN")).toEqual(["BEGIN"]);
  });
});

describe("pg_dump 17 output is executable by the node client", () => {
  it("strips the psql-only restrict markers", async () => {
    // pg_dump 17.6+ brackets output with \\restrict / \\unrestrict, which are
    // psql meta-commands the pg client cannot parse.
    const NL = String.fromCharCode(10);
    const BS = String.fromCharCode(92);
    write(BASELINE, [`${BS}restrict abc123`, "SET client_encoding = 'UTF8';", BASELINE_SQL, `${BS}unrestrict abc123`, ""].join(NL));
    const f = fakePool();
    await runMigrations(f.pool);
    const executed = f.statements().find((s) => s.includes(BASELINE_SQL))!;
    expect(executed).toBe(["SET client_encoding = 'UTF8';", BASELINE_SQL, ""].join(NL));
    expect(executed).not.toContain(BS);
  });
});
