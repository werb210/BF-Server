// BF_SERVER_SMS_LOOP_KILL_v121
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPermanentSmsFailure, isUndeliverableNumber, twilioErrorCode } from "../smsDeliverability.js";

const worker = readFileSync(resolve(__dirname, "..", "..", "workers", "deadLetterWorker.ts"), "utf-8");
const service = readFileSync(resolve(__dirname, "..", "..", "modules", "notifications", "sms.service.ts"), "utf-8");
const sheet = readFileSync(resolve(__dirname, "..", "..", "modules", "submissions", "merchantGrowthSheet.ts"), "utf-8");

describe("undeliverable SMS numbers", () => {
  it.each(["+15555555555", "(555) 555-5555", "+11234567891"])("rejects %s", (number) => {
    expect(isUndeliverableNumber(number)).toBe(true);
  });

  it("rejects short, empty, and identical-digit numbers", () => {
    for (const number of ["", "12345", "0000000000", "1111111111", null, undefined]) {
      expect(isUndeliverableNumber(number)).toBe(true);
    }
  });

  it("accepts plausible real numbers", () => {
    for (const number of ["+18254511768", "8254511768", "1-306-209-9483", "778.989.5508", "+14034211234"]) {
      expect(isUndeliverableNumber(number)).toBe(false);
    }
  });
});

describe("permanent SMS failures", () => {
  it.each([21211, 21214, 21408, 21610, 21612, 21614, 30003, 30005, 30006])("recognizes code %i", (code) => {
    expect(isPermanentSmsFailure({ code })).toBe(true);
  });

  it("does not classify transient errors as permanent", () => {
    for (const code of [20429, 500, 0]) expect(isPermanentSmsFailure({ code })).toBe(false);
  });

  it("reads either code or status", () => {
    expect(twilioErrorCode({ status: 21211 })).toBe(21211);
    expect(twilioErrorCode(new Error("boom"))).toBe(0);
  });
});

describe("dead-letter cycle prevention", () => {
  it("disables enqueueing from the worker", () => expect(worker).toContain("enqueueOnFailure: false"));
  it("does not wrap processJob in withRetry", () => expect(worker).not.toMatch(/withRetry\(\s*async\s*\(\)\s*=>\s*\{\s*await processJob/));
  it("conditionally enqueues failures", () => expect(service).toContain("if (enqueueOnFailure) {"));
  it("guards before the Twilio call", () => {
    expect(service.indexOf("isUndeliverableNumber(to)")).toBeLessThan(service.indexOf("client.messages.create"));
  });
  it("retires invalid queued destinations", () => expect(worker).toContain("isUndeliverableNumber(job.data?.to)"));
});

describe("mobile field", () => {
  it("does not fall back to the business phone", () => {
    expect(sheet).toContain("mobile: firstValidTenDigits(applicant.phone, row?.phone),");
  });
  it("keeps the business number in the phone field", () => {
    expect(sheet).toContain("phone: firstValidTenDigits(business.phone, applicant.phone, row?.phone),");
  });
});
