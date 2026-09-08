// BF_SERVER_BLOCK_v335_PUSH_INIT_NON_FATAL_v1
import { describe, expect, it, vi, afterEach } from "vitest";
import { initializeWatchPushProvider } from "../initWatchPush.js";

afterEach(() => vi.restoreAllMocks());

describe("watch push initialisation never blocks boot", () => {
  it("does not throw in production when config is partial", () => {
    // The exact staging failure: BUNDLE_ID present, the other three absent.
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      initializeWatchPushProvider({
        NODE_ENV: "production",
        WATCH_APNS_BUNDLE_ID: "financial.boreal.dialer",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("reports the missing names so the misconfiguration is visible", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    initializeWatchPushProvider({
      NODE_ENV: "production",
      WATCH_APNS_BUNDLE_ID: "financial.boreal.dialer",
    } as NodeJS.ProcessEnv);
    const logged = String(spy.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain("watch_apns_misconfigured");
    for (const name of ["WATCH_APNS_TEAM_ID", "WATCH_APNS_KEY_ID", "WATCH_APNS_PRIVATE_KEY"]) {
      expect(logged).toContain(name);
    }
  });

  it("returns false when nothing is configured at all", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(initializeWatchPushProvider({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
