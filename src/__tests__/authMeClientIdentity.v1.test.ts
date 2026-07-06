// AUTH_ME_CLIENT_IDENTITY_v1 - /api/auth/me must return identity for an
// OTP-verified CLIENT token (sub="client:<phone>", role="client"), not 401.
// Before this, the UUID gate rejected client tokens, useAuth() got null, the
// client widget never sent the phone, and Maya could not recognize the
// signed-in user.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const me = readFileSync(join(process.cwd(), "src", "routes", "auth", "me.ts"), "utf-8");

describe("auth/me client identity", () => {
  it("has a client-token branch that returns before the UUID gate", () => {
    expect(me).toContain("AUTH_ME_CLIENT_IDENTITY_v1");
    const branchIdx = me.indexOf("isClientToken");
    const uuidGateIdx = me.indexOf("UUID_REGEX.test(rawUserId)");
    expect(branchIdx).toBeGreaterThan(-1);
    expect(uuidGateIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeLessThan(uuidGateIdx);
  });

  it("returns phone and role=client from the token claims", () => {
    expect(me).toContain('role: "client"');
    expect(me).toContain("clientPhone");
    expect(me).toContain("user.phone");
  });

  it("detects client tokens by isClient flag or lowercase client role", () => {
    expect(me).toContain(".isClient === true");
    expect(me).toContain('rawRole.toLowerCase() === "client"');
  });
});
