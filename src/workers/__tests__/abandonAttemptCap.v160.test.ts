// BF_SERVER_ABANDON_ATTEMPT_CAP_v1
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isUndeliverableNumber } from "../../lib/smsDeliverability.js";

const worker = fs.readFileSync(path.resolve(__dirname, "../abandonedApplicationWorker.ts"), "utf8");
const migration = fs.readFileSync(
  path.resolve(__dirname, "../../../migrations/2026_09_08_v160_abandon_attempts.sql"), "utf8");

describe("no failure mode can retry forever", () => {
  it("stops selecting a row after three attempts", () => {
    // v119 handles permanent codes; a transient failure that never succeeds was
    // still unbounded, which is how the original incident began.
    expect(worker).toContain("COALESCE(a.abandon_sms_attempts, 0) < 3");
  });

  it("counts the attempt before sending, not after", () => {
    const increment = worker.indexOf("abandon_sms_attempts = COALESCE");
    const send = worker.indexOf("await sendSMS(String(row.phone)");
    expect(increment).toBeGreaterThan(-1);
    expect(increment).toBeLessThan(send);
  });

  it("checks deliverability at send time, not only in SQL", () => {
    expect(worker).toContain("isUndeliverableNumber(row.phone)");
    expect(worker).toContain("!isSendableBody(ABANDON_SMS_BODY)");
  });

  it("retires an undeliverable row rather than leaving it eligible", () => {
    const guard = worker.indexOf("isUndeliverableNumber(row.phone)");
    const stamp = worker.indexOf("abandon_sms_sent_at = now()", guard);
    expect(stamp).toBeGreaterThan(guard);
  });

  it("still rejects the numbers from the incident", () => {
    for (const n of ["+15555555555", "5555555555", "+11111111111"]) {
      expect(isUndeliverableNumber(n)).toBe(true);
    }
  });

  it("uses an idempotent migration like every other one here", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS abandon_sms_attempts");
  });
});
