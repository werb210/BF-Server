// BF_SERVER_PUSH_v59 - the audit row was written before the subscription
// check, so pwa_notification_audit recorded deliveries that never happened.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const SRC = fs.readFileSync("src/services/pushService.ts", "utf8");

describe("the audit only records real deliveries", () => {
  it("checks for subscriptions before writing the audit row", () => {
    const check = SRC.indexOf("subscriptions.length === 0");
    const audit = SRC.indexOf("createPwaNotificationAudit({");
    expect(check).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(check);
  });

  it("returns early when there is nothing to send to", () => {
    expect(SRC).toContain("return { sent: 0, failed: 0 };");
  });
});

describe("having no subscription is not a fault", () => {
  it("logs at info, not warn", () => {
    expect(SRC).toContain('logInfo("push_no_subscriptions"');
    expect(SRC).not.toContain('logWarn("push_no_subscriptions"');
  });

  it("still records who and which request, for tracing", () => {
    const block = SRC.slice(SRC.indexOf('logInfo("push_no_subscriptions"'));
    expect(block).toContain("userId: target.userId");
    expect(block).toContain("requestId");
  });
});
