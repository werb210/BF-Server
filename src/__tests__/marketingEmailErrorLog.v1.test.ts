import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
const runner = readFileSync(fileURLToPath(new URL("../services/marketingSendRunner.ts", import.meta.url)), "utf-8");
const mkt = readFileSync(fileURLToPath(new URL("../routes/marketing.ts", import.meta.url)), "utf-8");
describe("marketing email error logging", () => {
  it("logs the SendGrid failure reason instead of swallowing it", () => {
    expect(runner).toContain("sendgrid_email_failed");
    expect(mkt).toContain("sendgrid_test_failed");
  });
});
