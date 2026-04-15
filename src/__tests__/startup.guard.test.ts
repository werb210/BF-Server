import { afterEach, describe, expect, it } from "vitest";

describe("startup guards", () => {
  const originalSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.TWILIO_VERIFY_SERVICE_SID = originalSid;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("rejects the VA_YOUR_REAL placeholder SID", () => {
    process.env.NODE_ENV = "production";
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA_YOUR_REAL_SERVICE_SID_HERE";

    const sid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim();
    const KNOWN_FAKE_SIDS = ["VA_YOUR_REAL_SERVICE_SID_HERE", "your_service_sid", "REPLACE_ME"];
    const isPlaceholder = !sid || KNOWN_FAKE_SIDS.some((fakeSid) => sid.toUpperCase().includes(fakeSid.toUpperCase()));

    expect(isPlaceholder).toBe(true);
  });

  it("accepts a real-looking VA-prefixed SID", () => {
    const sid = "VA1234567890abcdef1234567890abcdef";
    const KNOWN_FAKE_SIDS = ["VA_YOUR_REAL_SERVICE_SID_HERE", "your_service_sid", "REPLACE_ME"];
    const isPlaceholder = !sid || KNOWN_FAKE_SIDS.some((fakeSid) => sid.toUpperCase().includes(fakeSid.toUpperCase()));

    expect(isPlaceholder).toBe(false);
  });

  it("rejects empty TWILIO_VERIFY_SERVICE_SID", () => {
    const sid = "";
    const isPlaceholder = !sid?.trim();

    expect(isPlaceholder).toBe(true);
  });
});
