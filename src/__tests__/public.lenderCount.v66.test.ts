// BF_SERVER_v66_LENDER_COUNT
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_v66_LENDER_COUNT", () => {
  const src = readFileSync(
    join(__dirname, "..", "routes", "public.ts"),
    "utf8"
  );

  it("anchor present", () => {
    expect(src.includes("BF_SERVER_v66_LENDER_COUNT")).toBe(true);
  });

  it("registers GET /lender-count handler", () => {
    expect(src).toMatch(/router\.get\(\s*"\/lender-count"/);
  });

  it("queries the lenders table for active rows", () => {
    expect(src).toMatch(/SELECT COUNT\(\*\)::text AS count FROM lenders/);
    expect(src).toMatch(/COALESCE\(active, true\) = true/);
  });

  it("returns the count via res.json with the ok() envelope", () => {
    // The handler explicitly calls res.json so the response actually reaches
    // the client (wrap() in this codebase doesn't inspect the return value).
    const idx = src.indexOf('"/lender-count"');
    expect(idx).toBeGreaterThan(-1);
    const next = src.indexOf("router.all(", idx);
    expect(next).toBeGreaterThan(idx);
    const block = src.slice(idx, next);
    expect(block).toMatch(/return res\.status\(200\)\.json\(ok\(\{ count \}\)\)/);
  });

  it("falls back to count: 0 on any failure (no exceptions surface)", () => {
    const idx = src.indexOf('"/lender-count"');
    const next = src.indexOf("router.all(", idx);
    const block = src.slice(idx, next);
    // Inner catch sets count = 0 before res.json fires.
    expect(block).toMatch(/count = 0;/);
  });
});
