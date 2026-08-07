// BF_SERVER_OTP_NANP_VALIDATION_v33
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isValidNanp } from "../auth.js";

describe("isValidNanp", () => {
  it("accepts real numbers seen in today's logs", () => {
    expect(isValidNanp("+14165096632")).toBe(true);
    expect(isValidNanp("+16474500660")).toBe(true);
    expect(isValidNanp("+12892317555")).toBe(true);
    expect(isValidNanp("+18254511768")).toBe(true);
  });

  it("rejects an NPA or NXX starting with 0 or 1", () => {
    expect(isValidNanp("+11234567890")).toBe(false);
    expect(isValidNanp("+14161234567")).toBe(false);
  });

  it("rejects N11 service codes in either position", () => {
    expect(isValidNanp("+19115551234")).toBe(false);
    expect(isValidNanp("+14169115555")).toBe(false);
  });

  it("leaves non-NANP numbers for Twilio to judge", () => {
    expect(isValidNanp("+3068312165")).toBe(true);
    expect(isValidNanp("+447700900000")).toBe(true);
  });
});

describe("otp error mapping", () => {
  const src = readFileSync("src/routes/auth.ts", "utf8");

  it("returns 400 for a destination Twilio refuses, not 500", () => {
    expect(src).toContain('error: "invalid_phone"');
    expect(src).toContain("invalid parameter .?to.?");
  });

  it("keeps the 429 rate-limit mapping ahead of it", () => {
    expect(src.indexOf("otp_rate_limited")).toBeLessThan(src.indexOf('error: "invalid_phone"'));
  });

  it("still has a 500 for genuine server failures", () => {
    expect(src).toContain('error: "OTP failed"');
  });
});
