import { describe, expect, it, beforeEach, vi } from "vitest";

describe("push startup validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../repositories/pwa.repo", () => ({
      createPwaNotificationAudit: vi.fn(),
      deletePwaSubscriptionByEndpoint: vi.fn(),
      listPwaSubscriptionsByUser: vi.fn().mockResolvedValue([]),
    }));
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/test";
    delete process.env.PWA_PUSH_ENABLED;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  it("throws in production when push is enabled and vapid vars are missing", async () => {
    const push = await import("../services/pushService");
    expect(() => push.validatePushEnvironmentAtStartup()).toThrowError(
      /VAPID configuration is required/
    );
  });

  it("does not throw when push is disabled", async () => {
    process.env.PWA_PUSH_ENABLED = "false";
    const push = await import("../services/pushService");
    expect(() => push.validatePushEnvironmentAtStartup()).not.toThrow();
  });
});
