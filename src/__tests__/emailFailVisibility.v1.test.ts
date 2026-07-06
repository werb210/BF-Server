import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = readFileSync(fileURLToPath(new URL("../services/marketingSendRunner.ts", import.meta.url)), "utf-8");
const marketing = readFileSync(fileURLToPath(new URL("../routes/marketing.ts", import.meta.url)), "utf-8");
const worker = readFileSync(fileURLToPath(new URL("../workers/sendQueueWorker.ts", import.meta.url)), "utf-8");

describe("BF_SERVER_EMAIL_FAIL_VISIBILITY_v1", () => {
  it("makes missing SendGrid configuration and inline rejects visible", () => {
    expect(runner).toContain("BF_SERVER_EMAIL_FAIL_VISIBILITY_v1");
    expect(marketing).toContain("sendgrid_not_configured");
    expect(marketing).toContain("rejectStatus");
    expect(marketing).toContain("rejectError");
    expect(marketing).toContain("rejected");
  });

  it("persists queued email rejects and reclaims stale running jobs", () => {
    expect(runner).toContain("rejectStatus");
    expect(runner).toContain("payload->>'subject'");
    expect(runner).toContain("interval '24 hours'");
    expect(worker).toContain("interval '10 minutes'");
    expect(worker).toContain("status='running'");
    expect(worker).toContain("rejected (status");
  });
});
