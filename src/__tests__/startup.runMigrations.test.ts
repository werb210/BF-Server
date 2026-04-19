import fs from "fs";
import path from "path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { runMigrations } from "../startup/runMigrations.js";

describe("startup runMigrations", () => {
  const existsSyncSpy = vi.spyOn(fs, "existsSync");
  const readdirSyncSpy = vi.spyOn(fs, "readdirSync");
  const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

  beforeEach(() => {
    existsSyncSpy.mockReset();
    readdirSyncSpy.mockReset();
    readFileSyncSpy.mockReset();
    warnSpy.mockReset();
    errorSpy.mockReset();
    logSpy.mockReset();

    warnSpy.mockImplementation(() => undefined);
    errorSpy.mockImplementation(() => undefined);
    logSpy.mockImplementation(() => undefined);

    existsSyncSpy.mockReturnValue(true);
    readdirSyncSpy.mockReturnValue(["001_init.sql", "002_add_index.sql"] as any);
    readFileSyncSpy.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
      if (String(filePath).endsWith("001_init.sql")) {
        return "create table t1(id int);";
      }
      return "create index idx_t1 on t1(id);";
    });
  });

  afterEach(() => undefined);

  it("skips already-applied migrations without executing SQL", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass('public.applied_migrations')")) {
        return { rows: [{ exists: "schema_migrations" }] };
      }
      if (sql === "select id from applied_migrations") {
        return { rows: [{ id: "001_init.sql" }, { id: "002_add_index.sql" }] };
      }
      return { rows: [] };
    });

    const pool = { query } as unknown as Pool;

    const start = Date.now();
    await runMigrations(pool);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(2000);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalledWith("create table t1(id int);");
    expect(query).toHaveBeenCalledWith("begin");
    expect(query).toHaveBeenCalledWith("commit");
  });

  it("logs known duplicate-object failures as warnings and never as errors", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("to_regclass('public.applied_migrations')")) {
        return { rows: [{ exists: null }] };
      }
      if (sql.startsWith("create table if not exists schema_migrations")) {
        return { rows: [] };
      }
      if (sql === "select id from schema_migrations") {
        return { rows: [] };
      }
      if (sql === "create table t1(id int);") {
        const err = new Error("duplicate relation");
        (err as Error & { code?: string }).code = "42P07";
        throw err;
      }
      if (sql.startsWith("insert into schema_migrations") && params?.[0] === "001_init.sql") {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const pool = { query } as unknown as Pool;

    await runMigrations(pool);

    expect(warnSpy).toHaveBeenCalledWith(
      "migration_already_present: 001_init.sql (42P07)"
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("migration_failed: 001_init.sql"),
      expect.anything()
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("insert into schema_migrations"),
      ["001_init.sql"]
    );
  });
});
