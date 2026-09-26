// BF_SERVER_BLOCK_v565 - rewritten for the current runner (per-file transactions on
// a pooled client, advisory lock, v159 schema baseline). The old version tested an
// applied_migrations runner that no longer exists.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { runMigrations } from "../startup/runMigrations.js";

let dir = "";
const write = (name: string, sql: string) => fs.writeFileSync(path.join(dir, "migrations", name), sql);

type Handler = (sql: string, params?: unknown[]) => { rows: any[] } | Promise<{ rows: any[] }>;
function fakePool(handler: Handler) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("information_schema.columns")) return { rows: [{ exists: true }] };
      return handler(sql, params);
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, calls, client };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  fs.mkdirSync(path.join(dir, "migrations"));
  write("001_a.sql", "create table a(id int);");
  write("002_b.sql", "create table b(id int);");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runMigrations", () => {
  it("skips migrations already recorded", async () => {
    const { pool, calls, client } = fakePool((sql) =>
      sql === "SELECT id FROM schema_migrations" ? { rows: [{ id: "001_a.sql" }, { id: "002_b.sql" }] } : { rows: [] });
    await runMigrations(pool);
    expect(calls.some((c) => c.sql === "BEGIN")).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  it("applies a new migration in its own transaction and records it", async () => {
    const { pool, calls } = fakePool((sql) =>
      sql === "SELECT id FROM schema_migrations" ? { rows: [{ id: "001_a.sql" }] } : { rows: [] });
    await runMigrations(pool);
    const i = calls.findIndex((c) => c.sql === "create table b(id int);");
    expect(calls[i - 1].sql).toBe("BEGIN");
    expect(calls[i + 1].params).toEqual(["002_b.sql"]);
    expect(calls[i + 2].sql).toBe("COMMIT");
  });

  it("records an already-present object (42P07) instead of failing", async () => {
    const { pool, calls } = fakePool((sql) => {
      if (sql === "SELECT id FROM schema_migrations") return { rows: [{ id: "001_a.sql" }] };
      if (sql === "create table b(id int);") throw Object.assign(new Error("exists"), { code: "42P07" });
      return { rows: [] };
    });
    await runMigrations(pool);
    expect(calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
    expect(calls.some((c) => c.sql.startsWith("INSERT INTO schema_migrations") && (c.params ?? [])[0] === "002_b.sql")).toBe(true);
  });

  it("stops on any other error", async () => {
    const { pool } = fakePool((sql) => {
      if (sql === "SELECT id FROM schema_migrations") return { rows: [] };
      if (sql === "create table a(id int);") throw Object.assign(new Error("syntax"), { code: "42601" });
      return { rows: [] };
    });
    await expect(runMigrations(pool)).rejects.toThrow("syntax");
  });

  it("loads the schema baseline on an empty database and records every migration", async () => {
    write("000000_baseline.sql", "\\restrict abc\nCREATE TABLE public.applications (id text);\n\\unrestrict abc\n");
    let recorded = false;
    const { pool, calls } = fakePool((sql) => {
      if (sql === "SELECT id FROM schema_migrations") return { rows: recorded ? [{ id: "001_a.sql" }, { id: "002_b.sql" }] : [] };
      if (sql.includes("to_regclass('public.applications')")) return { rows: [{ exists: false }] };
      if (sql === "COMMIT") recorded = true;
      return { rows: [] };
    });
    await runMigrations(pool);
    const baseline = calls.find((c) => c.sql.includes("CREATE TABLE public.applications"));
    expect(baseline?.sql).not.toContain("restrict");
    expect(calls.some((c) => c.sql === "create table a(id int);")).toBe(false);
    for (const f of ["001_a.sql", "002_b.sql", "000000_baseline.sql"]) {
      expect(calls.some((c) => c.sql.startsWith("INSERT INTO schema_migrations") && (c.params ?? [])[0] === f)).toBe(true);
    }
  });

  it("never loads the baseline over an existing schema", async () => {
    write("000000_baseline.sql", "CREATE TABLE public.applications (id text);");
    const { pool, calls } = fakePool((sql) => {
      if (sql === "SELECT id FROM schema_migrations") return { rows: [] };
      if (sql.includes("to_regclass('public.applications')")) return { rows: [{ exists: true }] };
      return { rows: [] };
    });
    await runMigrations(pool);
    expect(calls.some((c) => c.sql.includes("CREATE TABLE public.applications"))).toBe(false);
  });
});
