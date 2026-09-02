import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeWatchPushProvider } from "../initWatchPush.js";
import { configureWatchPushProvider } from "../notifications.js";

afterEach(() => { vi.restoreAllMocks(); configureWatchPushProvider(null); });

describe("initializeWatchPushProvider", () => {
  it("warns and remains disabled when no settings exist", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(initializeWatchPushProvider({ NODE_ENV: "production" })).toBe(false);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("watch_apns_not_configured"));
  });

  it("fails production startup with missing variable names only", () => {
    expect(() => initializeWatchPushProvider({ NODE_ENV: "production", WATCH_APNS_TEAM_ID: "secret-team" }))
      .toThrow("WATCH_APNS_KEY_ID, WATCH_APNS_PRIVATE_KEY, WATCH_APNS_BUNDLE_ID");
  });

  it("normalizes escaped key newlines and configures a complete provider", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(initializeWatchPushProvider({ NODE_ENV: "production", WATCH_APNS_TEAM_ID: "t", WATCH_APNS_KEY_ID: "k",
      WATCH_APNS_PRIVATE_KEY: pem.replace(/\n/g, "\\n"), WATCH_APNS_BUNDLE_ID: "example.watch" })).toBe(true);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "watch_apns_initialized", bundleId: "example.watch", configured: true }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(pem);
  });

  it("does nothing in test even if production settings are present", () => {
    expect(initializeWatchPushProvider({ NODE_ENV: "test", WATCH_APNS_TEAM_ID: "only-one" })).toBe(false);
  });
});
