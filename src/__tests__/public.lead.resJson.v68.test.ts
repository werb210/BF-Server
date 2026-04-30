// BF_SERVER_v68_LEAD_RES_JSON
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_v68_LEAD_RES_JSON", () => {
  const src = readFileSync(
    join(__dirname, "..", "routes", "public.ts"),
    "utf8"
  );

  it("anchor present", () => {
    expect(src).toContain("BF_SERVER_v68_LEAD_RES_JSON");
  });

  it("/lead success branch calls res.status(200).json(ok(...))", () => {
    expect(src).toMatch(/res\.status\(200\)\.json\(ok\(\{\s*leadId:/);
  });

  it("/lead invalid-input branch calls res.status(400).json(fail(...))", () => {
    expect(src).toMatch(/res\.status\(400\)\.json\(fail\(res,\s*"INVALID_INPUT"\)\)/);
  });

  it("/lead method-not-allowed catch-all calls res.status(405).json(fail(...))", () => {
    expect(src).toMatch(/res\.status\(405\)\.json\(fail\(res,\s*"METHOD_NOT_ALLOWED"\)\)/);
  });

  it("no remaining bare `return ok(...)` or bare `return fail(res, ...)` inside the /lead block", () => {
    const start = src.indexOf('router.post(\n  "/lead"');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("export default router", start);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/return ok\(\{\s*leadId:/);
    expect(block).not.toMatch(/return fail\(res,\s*"INVALID_INPUT"\);/);
    expect(block).not.toMatch(/=>\s*fail\(res,\s*"METHOD_NOT_ALLOWED"\)\)/);
  });
});
