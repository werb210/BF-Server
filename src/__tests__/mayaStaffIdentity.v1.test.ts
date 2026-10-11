import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../routes/maya.ts", import.meta.url)), "utf-8");
// BF_SERVER_MAYA_CONTEXT_v1 - the staff lookup moved to services/mayaContext.ts.
const ctx = readFileSync(fileURLToPath(new URL("../services/mayaContext.ts", import.meta.url)), "utf-8");

describe("Maya staff identity forwarding", () => {
  it("resolves the staff token subject and forwards a staff identity", () => {
    expect(ctx).toContain("FROM users WHERE id::text = $1");
    expect(ctx).toContain('audience: "staff"');
    expect(src).toContain("if (identity.staff) b.staff = identity.staff;");
    expect(src).toContain('fwdHeaders["X-Maya-Context"] = signMayaContext(identity);');
  });
});
