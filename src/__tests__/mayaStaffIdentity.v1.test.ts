import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../routes/maya.ts", import.meta.url)), "utf-8");
// BF_SERVER_v784_MAYA_IDENTITY - the staff lookup moved to services/mayaContext.ts and
// is sent as a signed X-Maya-Context; it is no longer injected into the body.
const ctx = readFileSync(fileURLToPath(new URL("../services/mayaContext.ts", import.meta.url)), "utf-8");

describe("Maya staff identity forwarding", () => {
  it("resolves the staff token subject and forwards a staff identity", () => {
    expect(src).toContain("deriveMayaIdentity(req)");
    expect(ctx).toContain("FROM users WHERE id::text = $1");
    expect(ctx).toContain('audience: "staff", staff: loaded.staff');
  });
});
