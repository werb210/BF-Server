// BF_SERVER_LENDER_SELF_NOTNULL_GUARD_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.join(process.cwd(), "src/routes/lenderSelf.ts"),
  "utf8",
);

describe("lender self-service never writes NULL into a NOT NULL column", () => {
  it("discovers NOT NULL columns at runtime", () => {
    expect(src).toContain("fetchNotNullLenderColumns");
    expect(src).toContain("is_nullable = 'NO'");
    expect(src).toContain("table_name = 'lenders'");
  });

  it("falls back to the known NOT NULL set if the lookup fails", () => {
    // A failed lookup must cost a skipped field, never a 500.
    expect(src).toContain('new Set(["name", "country", "active", "status", "has_broker_agreement"])');
  });

  it("skips blank values bound for NOT NULL columns rather than nulling them", () => {
    expect(src).toContain("fields[key] === null && notNullColumns.has(key)");
    expect(src).toContain("const keys = supplied.filter((key) => !skipped.includes(key))");
  });

  it("leaves nullable columns clearable", () => {
    // A lender must still be able to blank out an optional field such as
    // website or announcement; only NOT NULL columns are protected.
    expect(src).toContain("notNullColumns.has(key)");
    expect(src).not.toContain("fields[key] === null)\n      .filter");
  });

  it("reports which fields were kept instead of failing the save", () => {
    expect(src).toContain("keeping existing values");
    expect(src).toContain('return res.json({ status: "ok", data: current.rows[0], skipped })');
  });
});
