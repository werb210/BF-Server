// BF_SERVER_v65_COMMS_NO_400
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BF_SERVER_v65_COMMS_NO_400", () => {
  const src = readFileSync(join(__dirname, "..", "routes", "communications.ts"), "utf8");
  it("anchor present", () => { expect(src.includes("BF_SERVER_v65_COMMS_NO_400")).toBe(true); });
  it("missing contact_id returns 200 with empty messages, not 400", () => {
    const idx = src.indexOf('router.get("/messages"');
    expect(idx).toBeGreaterThan(-1);
    const next = src.indexOf('router.get(', idx + 5);
    expect(next).toBeGreaterThan(idx);
    const block = src.slice(idx, next);
    expect(block).toMatch(/res\.status\(200\)\.json\(\{\s*messages: \[\],\s*total: 0\s*\}\)/);
    expect(block).not.toMatch(/res\.status\(400\)\.json\(\{\s*error:.*contact_id is required/);
  });
});
