// BF_SERVER_v789_OTP_HASH_SALT
import { createHash, createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { logWarnMock } = vi.hoisted(() => {
  delete process.env.OTP_HASH_SALT;
  process.env.TWILIO_AUTH_TOKEN = "twilio-token-should-not-be-used";
  return { logWarnMock: vi.fn() };
});

vi.mock("../../../observability/logger.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, logWarn: logWarnMock };
});

vi.mock("../../../db.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn() },
  runQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
}));

import {
  resolveOtpHashSalt,
  warnIfOtpHashSaltDerived,
  resetOtpHashSaltWarningForTests,
} from "../otpHashSalt.js";

describe("resolveOtpHashSalt", () => {
  it("uses OTP_HASH_SALT when set", () => {
    expect(resolveOtpHashSalt("  my-salt  ", "jwt")).toEqual({ salt: "my-salt", derived: false });
  });

  it("derives HMAC-SHA256(JWT_SECRET, 'otp-hash-salt') when unset", () => {
    const expected = createHmac("sha256", "test-jwt-secret").update("otp-hash-salt").digest("hex");
    expect(resolveOtpHashSalt(undefined, "test-jwt-secret")).toEqual({ salt: expected, derived: true });
    expect(resolveOtpHashSalt("   ", "test-jwt-secret").salt).toBe(expected);
  });

  it("never falls back to the old constant", () => {
    expect(resolveOtpHashSalt(undefined, "test-jwt-secret").salt).not.toBe("staff-server-otp");
  });
});

describe("warnIfOtpHashSaltDerived", () => {
  beforeEach(() => {
    resetOtpHashSaltWarningForTests();
    logWarnMock.mockClear();
  });

  it("warns exactly once when OTP_HASH_SALT is unset", () => {
    expect(warnIfOtpHashSaltDerived(undefined)).toBe(true);
    expect(warnIfOtpHashSaltDerived(undefined)).toBe(false);
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock.mock.calls[0]?.[0]).toBe("otp_hash_salt_unset");
  });

  it("does not warn when OTP_HASH_SALT is set", () => {
    expect(warnIfOtpHashSaltDerived("configured")).toBe(false);
    expect(logWarnMock).not.toHaveBeenCalled();
  });
});

describe("hashOtpCode (auth.service)", () => {
  it("hashes with the JWT_SECRET-derived salt, not the Twilio token", async () => {
    resetOtpHashSaltWarningForTests();
    logWarnMock.mockClear();
    const { hashOtpCode } = await import("../auth.service.js");
    const jwtSecret = process.env.JWT_SECRET ?? "";
    const salt = createHmac("sha256", jwtSecret).update("otp-hash-salt").digest("hex");
    expect(hashOtpCode("123456")).toBe(createHash("sha256").update(`${salt}:123456`).digest("hex"));
    expect(hashOtpCode("123456")).not.toBe(
      createHash("sha256").update("twilio-token-should-not-be-used:123456").digest("hex"),
    );
    expect(logWarnMock.mock.calls.filter((c) => c[0] === "otp_hash_salt_unset")).toHaveLength(1);
  });
});
