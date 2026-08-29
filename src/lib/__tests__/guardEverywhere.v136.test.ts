// BF_SERVER_GUARD_EVERYWHERE_v136
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isUndeliverableNumber } from "../smsDeliverability.js";

const source = (...parts: string[]) => readFileSync(resolve(__dirname, "..", "..", ...parts), "utf-8");
const sites: Array<[string, string[]]> = [
  ["OTP login", ["routes", "auth", "otp.ts"]],
  ["staff/system SMS", ["services", "smsService.ts"]],
  ["marketing blasts", ["services", "marketingSms.ts"]],
  ["twilio helper", ["lib", "twilio.ts"]],
  ["portal doc rejection", ["routes", "portal.ts"]],
  ["staff communications", ["routes", "communications.ts"]],
];

describe("SMS deliverability", () => {
  it("conservatively classifies phone numbers", () => {
    expect(isUndeliverableNumber("+13444444953")).toBe(false);
    expect(isUndeliverableNumber("+15555555555")).toBe(true);
    expect(isUndeliverableNumber("+11234567890")).toBe(true);
    expect(isUndeliverableNumber("12345")).toBe(true);
    expect(isUndeliverableNumber("+18254511768")).toBe(false);
  });

  it.each(sites)("%s guards before sending", (_label, path) => {
    const src = source(...path);
    expect(src.indexOf("isUndeliverableNumber(")).toBeGreaterThan(-1);
    expect(src.indexOf("isUndeliverableNumber(")).toBeLessThan(src.indexOf("messages.create"));
  });

  it("maps failures to caller-appropriate results", () => {
    expect(source("routes", "auth", "otp.ts")).toContain("code === 21211");
    expect(source("routes", "auth", "otp.ts")).toContain("invalid_phone_number");
    expect(source("services", "marketingSms.ts")).toContain('error: "undeliverable_number"');
    expect(source("services", "smsService.ts")).toContain("skipped undeliverable number");
    expect(source("routes", "communications.ts")).toContain("That number cannot receive SMS.");
  });
});
