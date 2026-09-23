// BF_SERVER_LENDER_SILO_v449
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const root = process.cwd();
const route = readFileSync(path.join(root, "src/routes/mayaStaff.ts"), "utf8");
const migration = readFileSync(
  path.join(root, "migrations/20260923_lenders_silo_backfill.sql"), "utf8");

describe("v449 silo-filtered lender counts are no longer zero", () => {
  it("backfills both tables", () => {
    expect(migration).toContain("UPDATE lenders         SET silo = 'BF' WHERE silo IS NULL");
    expect(migration).toContain("UPDATE lender_products SET silo = 'BF' WHERE silo IS NULL");
  });

  it("is idempotent, per the project rule", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS");
    expect(migration.match(/WHERE silo IS NULL/g)?.length).toBe(2);
  });

  it("no silo-filtered lender query compares the raw column any more", () => {
    const bad = route.match(/FROM lenders? ?_?p?r?o?d?u?c?t?s? WHERE silo = \$1/g);
    expect(bad).toBeNull();
    expect(route).toContain("coalesce(silo, 'BF') = $1");
  });

  it("the byCategory query is covered too, not just the counts", () => {
    expect(route.match(/coalesce\(silo, 'BF'\) = \$1/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("records why, so nobody reverts the coalesce", () => {
    expect(route).toContain("silently dropped every lender");
  });
});
