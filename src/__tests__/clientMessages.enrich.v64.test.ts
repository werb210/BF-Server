// BF_SERVER_v64_CLIENT_MSG_ENRICH
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_v64_CLIENT_MSG_ENRICH", () => {
  const src = readFileSync(join(__dirname, "..", "routes", "client", "index.ts"),"utf8");
  it("anchor present", () => { expect(src.includes("BF_SERVER_v64_CLIENT_MSG_ENRICH")).toBe(true); });
  it("INSERT into communications_messages includes contact_id and silo from applications", () => {
    const start = src.indexOf('router.post(\n  "/messages"');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("export default router", start);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain("contact_id");
    expect(block).toContain("silo");
    expect(block).toMatch(/SELECT contact_id FROM applications WHERE id = \$2/);
    expect(block).toMatch(/SELECT silo FROM applications WHERE id = \$2/);
  });
});
