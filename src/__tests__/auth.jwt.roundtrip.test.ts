import { describe, expect, it, vi } from "vitest";

import { ROLES } from "../auth/roles.js";

describe("JWT round-trip", () => {
  it("signs and verifies token with sub field", async () => {
    process.env.JWT_SECRET = "test-secret";
    vi.resetModules();
    const { signAccessToken, verifyAccessToken } = await import("../auth/jwt.js");

    const payload = { sub: "user-123", role: ROLES.STAFF, tokenVersion: 0 };
    const token = signAccessToken(payload);
    const verified = verifyAccessToken(token);

    expect(verified.sub).toBe("user-123");
    expect(verified.role).toBe(ROLES.STAFF);
    expect(verified.tokenVersion).toBe(0);
  });
});
