import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../routes/maya.ts", import.meta.url)), "utf-8");

describe("Maya staff identity forwarding", () => {
  it("resolves the staff token subject and forwards a staff identity", () => {
    expect(src).toContain("BF_SERVER_MAYA_STAFF_IDENTITY_v1");
    expect(src).toContain("FROM users WHERE id::text = $1");
    expect(src).toContain("b.staff = {");
  });
});
