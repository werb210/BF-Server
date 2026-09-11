import { describe, it, expect } from "vitest";
import {
  pushConfigReport,
  pushConfigSummary,
  CLIENT_APNS_VARS,
  WATCH_APNS_VARS,
} from "../pushConfig.js";

const FULL: NodeJS.ProcessEnv = {
  WATCH_APNS_TEAM_ID: "T1",
  WATCH_APNS_KEY_ID: "K1",
  WATCH_APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
  WATCH_APNS_BUNDLE_ID: "com.boreal.dialer",
  CLIENT_APNS_BUNDLE_ID_BF: "com.boreal.client",
  FIREBASE_SERVICE_ACCOUNT_JSON: "{}",
};

describe("BF_SERVER_PUSH_CONFIG_DIAG_v153", () => {
  it("reports everything configured when it is", () => {
    const r = pushConfigReport(FULL);
    expect(r.anyConfigured).toBe(true);
    expect(r.transports.every((t) => t.configured)).toBe(true);
    expect(r.sharedMissing).toEqual([]);
  });

  it("names the one missing variable rather than just saying not configured", () => {
    const env = { ...FULL };
    delete env.CLIENT_APNS_BUNDLE_ID_BF;
    const r = pushConfigReport(env);
    const client = r.transports.find((t) => t.transport === "client_apns");
    expect(client?.configured).toBe(false);
    expect(client?.missing).toEqual(["CLIENT_APNS_BUNDLE_ID_BF"]);
    // Watch push is unaffected - which is how you know it is only the bundle id.
    expect(r.transports.find((t) => t.transport === "watch_apns")?.configured).toBe(true);
  });

  it("identifies a shared credential so it is not chased three times", () => {
    const env = { ...FULL };
    delete env.WATCH_APNS_KEY_ID;
    const r = pushConfigReport(env);
    expect(r.sharedMissing).toEqual(["WATCH_APNS_KEY_ID"]);
    expect(r.transports.find((t) => t.transport === "client_apns")?.configured).toBe(false);
    expect(r.transports.find((t) => t.transport === "watch_apns")?.configured).toBe(false);
  });

  it("treats a blank value as missing, not present", () => {
    const r = pushConfigReport({ ...FULL, CLIENT_APNS_BUNDLE_ID_BF: "   " });
    expect(r.transports.find((t) => t.transport === "client_apns")?.missing)
      .toEqual(["CLIENT_APNS_BUNDLE_ID_BF"]);
  });

  it("reports FCM separately from APNs", () => {
    const env = { ...FULL };
    delete env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const r = pushConfigReport(env);
    expect(r.transports.find((t) => t.transport === "fcm")?.missing)
      .toEqual(["FIREBASE_SERVICE_ACCOUNT_JSON"]);
    expect(r.anyConfigured).toBe(true);
  });

  it("says nothing is configured when nothing is", () => {
    const r = pushConfigReport({});
    expect(r.anyConfigured).toBe(false);
    expect(r.transports.every((t) => !t.configured)).toBe(true);
  });

  it("never reports a variable's value", () => {
    const summary = pushConfigSummary({ ...FULL, WATCH_APNS_PRIVATE_KEY: "SUPER_SECRET" });
    expect(summary).not.toContain("SUPER_SECRET");
    const serialised = JSON.stringify(pushConfigReport(FULL));
    expect(serialised).not.toContain("com.boreal.client");
    expect(serialised).not.toContain("BEGIN PRIVATE KEY");
  });

  it("summarises in one log-friendly line", () => {
    const env = { ...FULL };
    delete env.CLIENT_APNS_BUNDLE_ID_BF;
    const summary = pushConfigSummary(env);
    expect(summary).toContain("client_apns=missing[CLIENT_APNS_BUNDLE_ID_BF]");
    expect(summary).toContain("watch_apns=ok");
    expect(summary.split("\n").length).toBe(1);
  });

  it("keeps the variable lists in step with the services that read them", () => {
    expect(CLIENT_APNS_VARS).toContain("CLIENT_APNS_BUNDLE_ID_BF");
    expect(WATCH_APNS_VARS).toContain("WATCH_APNS_BUNDLE_ID");
    for (const shared of ["WATCH_APNS_TEAM_ID", "WATCH_APNS_KEY_ID", "WATCH_APNS_PRIVATE_KEY"]) {
      expect(CLIENT_APNS_VARS).toContain(shared);
      expect(WATCH_APNS_VARS).toContain(shared);
    }
  });
});
