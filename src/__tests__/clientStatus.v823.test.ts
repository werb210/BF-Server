// BF_SERVER_v823_LIVE_ACTIVITY - the client app's lock-screen status: what each stage shows, the APNs Live Activity
// and Android payloads, and the sweep that only pushes a changed stage.
import { describe, expect, it, vi } from "vitest";
import {
  androidStatusData, liveActivityPayload, runStatusSweep, statusContent, statusSignature, validWatch,
} from "../services/clientStatus/applicationStatusLive.js";

const TOKEN = "a".repeat(64);

describe("statusContent", () => {
  it("maps pipeline states to the client's step names", () => {
    expect(statusContent("In Review")).toEqual({ stage: "In Review", step: 2, totalSteps: 7, action: "We're working on it", final: false });
    expect(statusContent("documents_required")).toMatchObject({ stage: "Documents Required", step: 3, action: "Upload your documents" });
    expect(statusContent("Off to Lender")).toMatchObject({ step: 5, action: "With lenders now" });
    expect(statusContent("offer")).toMatchObject({ stage: "Offer", step: 6, action: "Review your offer" });
  });

  it("treats Accepted / Funded as done and declined files as closed", () => {
    expect(statusContent("Accepted")).toMatchObject({ stage: "Funded", step: 7, final: true });
    expect(statusContent("declined")).toMatchObject({ stage: "Closed", final: true });
  });

  it("keeps an unknown stage's own words", () => {
    expect(statusContent("credit_check")).toMatchObject({ stage: "credit check", step: 1, final: false });
    expect(statusContent(null)).toMatchObject({ stage: "Received" });
  });
});

describe("payloads", () => {
  it("updates the Live Activity and lights the screen once", () => {
    const payload = liveActivityPayload(statusContent("offer"), 1_000) as any;
    expect(payload.aps.event).toBe("update");
    expect(payload.aps.timestamp).toBe(1_000);
    expect(payload.aps["content-state"]).toEqual({ stage: "Offer", step: 6, totalSteps: 7, action: "Review your offer" });
    expect(payload.aps.alert.body).toBe("Offer · Review your offer");
  });

  it("ends the Live Activity at a final stage, four hours later", () => {
    const payload = liveActivityPayload(statusContent("funded"), 1_000) as any;
    expect(payload.aps.event).toBe("end");
    expect(payload.aps["dismissal-date"]).toBe(1_000 + 4 * 3600);
    expect(payload.aps.alert).toBeUndefined();
  });

  it("sends Android a data message the app draws itself", () => {
    expect(androidStatusData("app-1", statusContent("in_review"))).toEqual({
      type: "application_status", applicationId: "app-1", stage: "In Review", step: "2", totalSteps: "7",
      action: "We're working on it", final: "0",
    });
  });
});

describe("validWatch", () => {
  it("needs an application, a platform and, on iPhone, a hex activity token", () => {
    expect(validWatch({ applicationId: "app-1", platform: "ios", userId: "u1", activityToken: TOKEN })).toBe(true);
    expect(validWatch({ applicationId: "app-1", platform: "android", userId: "u1" })).toBe(true);
    expect(validWatch({ applicationId: "app-1", platform: "ios", userId: "u1", activityToken: "not hex!" })).toBe(false);
    expect(validWatch({ applicationId: "", platform: "android", userId: "u1" })).toBe(false);
    expect(validWatch({ applicationId: "app-1", platform: "web" as any, userId: "u1" })).toBe(false);
  });
});

describe("runStatusSweep", () => {
  function fakeDb(rows: any[]) {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/FROM client_status_watch w/.test(sql)) return { rows };
      return { rows: [], rowCount: 1 };
    });
    return { db: { query }, calls };
  }

  it("pushes only applications whose stage changed, and records what was sent", async () => {
    const { db, calls } = fakeDb([
      { id: "w1", application_id: "app-1", platform: "ios", user_id: "u1", activity_token: TOKEN, environment: "production",
        last_signature: statusSignature(statusContent("in_review")), pipeline_state: "offer" },
      { id: "w2", application_id: "app-2", platform: "android", user_id: "u2", activity_token: null, environment: "production",
        last_signature: statusSignature(statusContent("in_review")), pipeline_state: "In Review" },
    ]);
    const sendLiveActivity = vi.fn(async () => undefined);
    const sendAndroid = vi.fn(async () => 1);
    const sent = await runStatusSweep({ db, senders: { sendLiveActivity, sendAndroid }, now: () => 5_000_000 });
    expect(sent).toBe(1);
    expect(sendLiveActivity).toHaveBeenCalledTimes(1);
    expect(sendLiveActivity.mock.calls[0]![0]).toBe(TOKEN);
    expect(sendAndroid).not.toHaveBeenCalled();
    const update = calls.find((c) => /SET last_signature = \$2/.test(c.sql));
    expect(update?.params).toEqual(["w1", statusSignature(statusContent("offer")), null, false]);
  });

  it("sends Android the status and closes a funded file", async () => {
    const { db, calls } = fakeDb([
      { id: "w3", application_id: "app-3", platform: "android", user_id: "u3", activity_token: null, environment: "production",
        last_signature: "x", pipeline_state: "Funded" },
    ]);
    const sendAndroid = vi.fn(async () => 1);
    await runStatusSweep({ db, senders: { sendLiveActivity: vi.fn(), sendAndroid }, now: () => 0 });
    expect(sendAndroid.mock.calls[0]![0]).toBe("u3");
    expect((sendAndroid.mock.calls[0]![1] as any).final).toBe("1");
    const update = calls.find((c) => /SET last_signature = \$2/.test(c.sql));
    expect(update?.params?.[2]).toBe(new Date(0).toISOString());
  });

  it("ends a watch whose Live Activity token Apple no longer accepts", async () => {
    const { db, calls } = fakeDb([
      { id: "w4", application_id: "app-4", platform: "ios", user_id: "u4", activity_token: TOKEN, environment: "production",
        last_signature: "x", pipeline_state: "offer" },
    ]);
    const sendLiveActivity = vi.fn(async () => { throw Object.assign(new Error("gone"), { reason: "Unregistered" }); });
    const sent = await runStatusSweep({ db, senders: { sendLiveActivity, sendAndroid: vi.fn() } });
    expect(sent).toBe(0);
    expect(calls.some((c) => /SET ended_at = now\(\), updated_at = now\(\) WHERE id = \$1/.test(c.sql) && c.params?.[0] === "w4")).toBe(true);
  });

  it("does nothing when no one is watching", async () => {
    const { db } = fakeDb([]);
    expect(await runStatusSweep({ db })).toBe(0);
  });
});

describe("v823 Live Activity lifetime", () => {
  const base = { application_id: "app-5", platform: "ios", user_id: "u5", environment: "production", business: "Northwind",
    last_signature: "x", pipeline_state: "offer" };
  function fakeDb(rows: any[]) {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/FROM client_status_watch w/.test(sql)) return { rows };
      return { rows: [], rowCount: 1 };
    });
    return { db: { query }, calls };
  }

  it("updates a Live Activity started within the last 8 hours", async () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    const { db } = fakeDb([{ ...base, id: "w5", activity_token: TOKEN, start_token: "b".repeat(64),
      activity_started_at: new Date(now - 3600_000).toISOString() }]);
    const sendLiveActivity = vi.fn(async () => undefined);
    await runStatusSweep({ db, senders: { sendLiveActivity, sendAndroid: vi.fn() }, now: () => now });
    expect(sendLiveActivity.mock.calls[0]![0]).toBe(TOKEN);
    expect((sendLiveActivity.mock.calls[0]![2] as any).aps.event).toBe("update");
  });

  it("starts a new one with the push-to-start token once iOS has ended the old one", async () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    const { db, calls } = fakeDb([{ ...base, id: "w6", activity_token: TOKEN, start_token: "b".repeat(64),
      activity_started_at: new Date(now - 9 * 3600_000).toISOString() }]);
    const sendLiveActivity = vi.fn(async () => undefined);
    await runStatusSweep({ db, senders: { sendLiveActivity, sendAndroid: vi.fn() }, now: () => now });
    const payload = sendLiveActivity.mock.calls[0]![2] as any;
    expect(sendLiveActivity.mock.calls[0]![0]).toBe("b".repeat(64));
    expect(payload.aps.event).toBe("start");
    expect(payload.aps["attributes-type"]).toBe("ApplicationStatusAttributes");
    expect(payload.aps.attributes).toEqual({ applicationId: "app-5", business: "Northwind" });
    const update = calls.find((c) => /SET last_signature = \$2/.test(c.sql));
    expect(update?.params?.[3]).toBe(true); // the old activity token is forgotten
  });

  it("does not start an activity just to say the file is closed", async () => {
    const { db } = fakeDb([{ ...base, id: "w7", pipeline_state: "declined", activity_token: null, activity_started_at: null,
      start_token: "b".repeat(64) }]);
    const sendLiveActivity = vi.fn(async () => undefined);
    const sent = await runStatusSweep({ db, senders: { sendLiveActivity, sendAndroid: vi.fn() } });
    expect(sendLiveActivity).not.toHaveBeenCalled();
    expect(sent).toBe(0);
  });

  it("accepts an iPhone watch with only a push-to-start token", () => {
    expect(validWatch({ applicationId: "app-1", platform: "ios", userId: "u1", startToken: TOKEN })).toBe(true);
    expect(validWatch({ applicationId: "app-1", platform: "ios", userId: "u1" })).toBe(false);
  });
});
