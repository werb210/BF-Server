import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROLES } from "../auth/roles.js";

describe("JWT round-trip", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret-minimum-10-chars";
    vi.resetModules();
  });

  it("signs and verifies token with sub field and issuer/audience", async () => {
    const { signAccessToken, verifyAccessToken } = await import("../auth/jwt.js");

    const payload = { sub: "user-123", role: ROLES.STAFF, tokenVersion: 0 };
    const token = signAccessToken(payload);
    const verified = verifyAccessToken(token);

    expect(verified.sub).toBe("user-123");
    expect(verified.role).toBe(ROLES.STAFF);
    expect(verified.tokenVersion).toBe(0);
  });

  it("test-mode token from OTP verify also passes verifyAccessToken", async () => {
    const { signAccessToken, verifyAccessToken } = await import("../auth/jwt.js");
    const token = signAccessToken({
      sub: "test-user:+15550001234",
      role: ROLES.STAFF,
      tokenVersion: 0,
      phone: "+15550001234",
    });

    const verified = verifyAccessToken(token);
    expect(verified.sub).toBe("test-user:+15550001234");
  });
});
