// BF_SERVER_WATCH_PRESENCE_TABLE_v214
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const snap = readFileSync("src/watch/snapshotRoutes.ts", "utf-8");
const service = readFileSync("src/modules/presence/presenceService.ts", "utf-8");

const allMigrations = readdirSync("migrations")
  .map((f) => readFileSync(`migrations/${f}`, "utf-8"))
  .join("\n");

describe("the presence query that never worked", () => {
  it("no longer reads a table that does not exist", () => {
    expect(allMigrations).not.toMatch(/CREATE TABLE (IF NOT EXISTS )?user_presence/);
    expect(snap).not.toContain("FROM user_presence");
  });

  it("reads the table presenceService actually writes", () => {
    expect(allMigrations).toContain("CREATE TABLE IF NOT EXISTS staff_presence");
    expect(service).toContain("staff_presence");
    expect(snap).toContain("FROM staff_presence");
  });

  it("only returns a status the CHECK constraint permits", () => {
    // staff_presence allows available|busy|offline. "away" was never one of
    // them - it was only ever the fallback of a query that always failed.
    const statuses = ["available", "busy", "offline"];
    for (const s of statuses) expect(allMigrations).toContain(`'${s}'`);
    expect(snap).not.toContain('"away"');
  });
});

describe("a stale heartbeat is not a live status", () => {
  it("treats an old heartbeat as offline", () => {
    expect(snap).toContain("last_heartbeat < now() - interval '5 minutes'");
    expect(snap).toContain("row.stale ? \"offline\" : row.status");
  });

  it("treats a missing row as offline rather than guessing", () => {
    expect(snap).toContain('!row ? "offline"');
  });
});

describe("every query in this file targets something real", () => {
  it("names only tables the migrations create", () => {
    const tables = [...snap.matchAll(/FROM\s+([a-z_]+)/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      expect(allMigrations).toMatch(new RegExp(`CREATE TABLE (IF NOT EXISTS )?${t}\\b`));
    }
  });
});
