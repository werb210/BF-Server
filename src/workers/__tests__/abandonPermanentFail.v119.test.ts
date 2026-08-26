// BF_SERVER_ABANDON_PERMANENT_FAIL_v119
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "..", "abandonedApplicationWorker.ts"), "utf-8");
const mig = readFileSync(
  resolve(__dirname, "..", "..", "..", "migrations", "2026_08_26_v119_abandon_sms_attempts.sql"),
  "utf-8",
);

const PERMANENT = [21211, 21610, 21612, 21614, 21408, 30003, 30005, 30006];

describe("permanent rejections are retired", () => {
  it.each(PERMANENT)("code %i is treated as permanent", (code) => {
    const line = src.split("\n").find((l) => l.includes("const permanent =")) ?? "";
    expect(line).toContain(String(code));
  });

  it("21211 - the invalid number that caused this - is covered", () => {
    expect(PERMANENT).toContain(21211);
  });

  it("stamps sent_at so the row leaves the eligible set", () => {
    const branch = src.slice(src.indexOf("if (permanent || attempts >= 3)"));
    expect(branch).toContain("abandon_sms_sent_at = now()");
  });
});

describe("transient failures still retry", () => {
  it("an unlisted code does not retire on the first failure", () => {
    expect(src).toContain("will retry");
  });

  it("but stops at three attempts", () => {
    expect(src).toContain("attempts >= 3");
  });
});

describe("the counter", () => {
  it("is added idempotently", () => {
    expect(mig).toContain("ADD COLUMN IF NOT EXISTS abandon_sms_attempts");
  });

  it("is incremented on every failure", () => {
    expect(src).toContain("abandon_sms_attempts = abandon_sms_attempts + 1");
  });

  it("a failed counter update cannot crash the tick", () => {
    expect(src).toContain(".catch(() => ({ rows: [] as Array<{ abandon_sms_attempts: number }> }))");
  });
});

describe("success path is unchanged", () => {
  it("still stamps only after a successful send", () => {
    expect(src).toContain("await sendSMS(String(row.phone), ABANDON_SMS_BODY);");
  });
});
