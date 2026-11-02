// BF_SERVER_v879_NO_PGCRYPTO - Azure Database for PostgreSQL does not allow-list pgcrypto, so an unguarded
// CREATE EXTENSION pgcrypto stops the server starting (it did on 2026-11-02). CI runs plain Postgres, where it works,
// so check the files themselves. The one guarded use (inside a DO block that catches the error) is allowed.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("migrations never require pgcrypto", () => {
  it("has no unguarded CREATE EXTENSION pgcrypto", () => {
    const dir = join(process.cwd(), "migrations");
    const offenders = readdirSync(dir).filter((f) => f.endsWith(".sql")).filter((f) => {
      const sql = readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "");
      if (!/create\s+extension[^;]*pgcrypto/i.test(sql)) return false;
      return !/exception\s+when/i.test(sql); // guarded: the failure is caught and the migration carries on
    });
    expect(offenders).toEqual([]);
  });
});
